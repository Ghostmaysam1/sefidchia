import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Markup, type Telegraf } from "telegraf";

interface Candidate {
    userId: number;
    postDate: number;
    commentDate: number;
}

interface RotationState {
    active: boolean;
    intervalMs: number;
    cycleStartedAt: number | null;
    nextRotationAt: number | null;
    channels: string[];
    discussionGroups: Record<string, string>;
    currentAdmins: Record<string, number>;
    forcedNext: Record<string, number>;
    candidates: Record<string, Candidate[]>;
}

type PendingInput =
    | { type: "channels" }
    | { type: "interval" }
    | { type: "forced_user"; channelId: string };

const defaultState = (): RotationState => ({
    active: false,
    intervalMs: 2 * 60 * 60 * 1000,
    cycleStartedAt: null,
    nextRotationAt: null,
    channels: [],
    discussionGroups: {},
    currentAdmins: {},
    forcedNext: {},
    candidates: {},
});

const statePath = resolve(process.env.ROTATION_STATE_PATH ?? "data/rotation-state.json");
let state = defaultState();
let saveQueue = Promise.resolve();
let isRotating = false;
const pendingInputs = new Map<number, PendingInput>();

async function saveState(): Promise<void> {
    saveQueue = saveQueue.catch(() => undefined).then(async () => {
        await mkdir(dirname(statePath), { recursive: true });
        await writeFile(statePath, JSON.stringify(state, null, 2), "utf8");
    });
    await saveQueue;
}

async function loadState(): Promise<void> {
    try {
        const stored = JSON.parse(await readFile(statePath, "utf8")) as Partial<RotationState>;
        state = { ...defaultState(), ...stored };
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            console.error("Could not load rotation state:", error);
        }
    }
}

function isOwner(ownerId: number, userId?: number): boolean {
    return userId === ownerId;
}

function channelLabel(channelId: string): string {
    return channelId.startsWith("@") ? channelId : `کانال ${channelId}`;
}

function normalizeDigits(value: string): string {
    return value.replace(/[۰-۹٠-٩]/g, (digit) => {
        const persianDigits = "۰۱۲۳۴۵۶۷۸۹";
        const arabicDigits = "٠١٢٣٤٥٦٧٨٩";
        const index = persianDigits.indexOf(digit);
        return String(index >= 0 ? index : arabicDigits.indexOf(digit));
    });
}

function formatInterval(intervalMs: number): string {
    if (intervalMs < 60_000) return `${intervalMs / 1000} ثانیه`;
    if (intervalMs < 3_600_000) return `${intervalMs / 60_000} دقیقه`;
    return `${intervalMs / 3_600_000} ساعت`;
}

function dashboardText(): string {
    const next = state.nextRotationAt
        ? new Date(state.nextRotationAt).toLocaleString("fa-IR")
        : "تنظیم نشده";
    const overrides = state.channels
        .filter((channelId) => state.forcedNext[channelId] !== undefined)
        .map((channelId) => `${channelLabel(channelId)}: ${state.forcedNext[channelId]}`);
    const candidateCount = state.channels.reduce((total, channelId) => {
        const users = new Set((state.candidates[channelId] ?? []).map((candidate) => candidate.userId));
        return total + users.size;
    }, 0);
    const linkedGroupCount = new Set(Object.values(state.discussionGroups)).size;
    return [
        "مدیریت چرخهٔ ادمین",
        `وضعیت: ${state.active ? "فعال" : "غیرفعال"}`,
        `بازه: ${formatInterval(state.intervalMs)}`,
        `کانال‌ها: ${state.channels.length ? state.channels.map(channelLabel).join("، ") : "ثبت نشده"}`,
        `گروه گفت‌وگوی متصل: ${linkedGroupCount} از ${state.channels.length}`,
        `انتخاب دستی بعدی: ${overrides.length ? overrides.join("، ") : "ندارد"}`,
        `شرکت‌کننده‌های ثبت‌شده: ${candidateCount}`,
        `اجرای بعدی: ${next}`,
    ].join("\n");
}

function dashboardKeyboard() {
    return Markup.inlineKeyboard([
        [Markup.button.callback(state.active ? "⏸ توقف چرخه" : "▶️ فعال‌سازی چرخه", "rotation_toggle")],
        [
            Markup.button.callback("📣 کانال‌ها", "channels_menu"),
            Markup.button.callback("⏱ بازهٔ زمانی", "interval_menu"),
        ],
        [
            Markup.button.callback("🎯 انتخاب ادمین بعدی", "force_menu"),
            Markup.button.callback("🧹 لغو انتخاب دستی", "clear_force_menu"),
        ],
        [Markup.button.callback("🔄 بروزرسانی", "dashboard")],
    ]);
}

function channelSelectionKeyboard(action: "force" | "clear") {
    const buttons = state.channels.map((channelId) => [
        Markup.button.callback(
            `${action === "force" ? "🎯" : "🧹"} ${channelLabel(channelId)}`,
            `${action}:${channelId}`,
        ),
    ]);
    buttons.push([Markup.button.callback("⬅️ بازگشت", "dashboard")]);
    return Markup.inlineKeyboard(buttons);
}

function cancelInputKeyboard() {
    return Markup.inlineKeyboard([[Markup.button.callback("لغو", "cancel_input")]]);
}

async function demoteAdmin(bot: Telegraf, channelId: string, userId: number): Promise<void> {
    await bot.telegram.promoteChatMember(channelId, userId, {
        can_manage_chat: false,
        can_post_messages: false,
        can_edit_messages: false,
        can_delete_messages: false,
        can_invite_users: false,
        can_restrict_members: false,
        can_promote_members: false,
        can_change_info: false,
        can_pin_messages: false,
        can_manage_video_chats: false,
        is_anonymous: false,
    });
}

async function rotate(bot: Telegraf, now: number): Promise<void> {
    const cycleStart = state.cycleStartedAt ?? now - state.intervalMs;

    for (const channelId of state.channels) {
        const previousId = state.currentAdmins[channelId];
        let rotationSucceeded = false;

        try {
            const administrators = await bot.telegram.getChatAdministrators(channelId);
            const adminIds = new Set(administrators.map((administrator) => administrator.user.id));
            const candidates = state.candidates[channelId] ?? [];
            const uniqueCandidates = [...new Map(
                candidates
                    .filter((candidate) => {
                        const candidateDate = state.intervalMs < 60_000
                            ? candidate.commentDate ?? candidate.postDate
                            : candidate.postDate;
                        return candidateDate >= cycleStart && candidateDate < now && !adminIds.has(candidate.userId);
                    })
                    .map((candidate) => [candidate.userId, candidate]),
            ).values()];
            const forcedId = state.forcedNext[channelId];
            const forcedAdminSelected = forcedId !== undefined && adminIds.has(forcedId);
            const winnerId = forcedAdminSelected
                ? uniqueCandidates.length
                    ? uniqueCandidates[Math.floor(Math.random() * uniqueCandidates.length)].userId
                    : undefined
                : forcedId ?? (uniqueCandidates.length
                    ? uniqueCandidates[Math.floor(Math.random() * uniqueCandidates.length)].userId
                    : undefined);

            if (winnerId === undefined) {
                if (previousId !== undefined) {
                    await demoteAdmin(bot, channelId, previousId);
                    delete state.currentAdmins[channelId];
                }
                const message = forcedAdminSelected
                    ? "انتخاب دستی رد شد چون آن کاربر از قبل ادمین است؛ در این دوره شرکت‌کنندهٔ واجد شرایط دیگری نبود."
                    : "برای این دوره کامنت‌گذار واجد شرایطی که ادمین کانال نباشد پیدا نشد.";
                await bot.telegram.sendMessage(channelId, message);
                rotationSucceeded = true;
            } else {
                const member = await bot.telegram.getChatMember(channelId, winnerId);
                const isMember = member.status !== "left" && member.status !== "kicked" &&
                    (member.status !== "restricted" || member.is_member);
                const displayName = [member.user.first_name, member.user.last_name].filter(Boolean).join(" ")
                    || "ادمین جدید";

                if (member.status === "creator") {
                    if (previousId !== undefined && previousId !== winnerId) {
                        await demoteAdmin(bot, channelId, previousId);
                        delete state.currentAdmins[channelId];
                    }
                    await bot.telegram.sendMessage(
                        channelId,
                        `${displayName} مالک اصلی کانال است و از قبل دسترسی کامل دارد.`,
                    );
                    rotationSucceeded = true;
                } else if (!isMember) {
                    await bot.telegram.sendMessage(
                        channelId,
                        `کاربر ${winnerId} عضو کانال نیست. ابتدا باید عضو کانال شود؛ انتخاب دستی برای دورهٔ بعد نگه داشته شد.`,
                    );
                } else {
                    await bot.telegram.promoteChatMember(channelId, winnerId, {
                        can_manage_chat: false,
                        can_post_messages: true,
                        can_edit_messages: false,
                        can_delete_messages: false,
                        can_invite_users: true,
                        can_restrict_members: false,
                        can_promote_members: false,
                        can_change_info: false,
                        can_pin_messages: false,
                        can_manage_video_chats: false,
                        is_anonymous: false,
                    });

                    if (previousId !== undefined && previousId !== winnerId) {
                        await demoteAdmin(bot, channelId, previousId);
                    }

                    state.currentAdmins[channelId] = winnerId;
                    const note = forcedAdminSelected ? "\nانتخاب دستی به‌دلیل ادمین‌بودن نادیده گرفته شد." : "";
                    await bot.telegram.sendMessage(channelId, `ادمین این دوره: ${displayName}${note}`);
                    rotationSucceeded = true;
                }
            }
        } catch (error) {
            console.error(`Admin rotation failed for ${channelId}:`, error);
            try {
                await bot.telegram.sendMessage(
                    channelId,
                    "ارتقای ادمین انجام نشد. مطمئن شوید کاربر عضو کانال است و ربات اجازهٔ ارتقای ادمین‌ها را دارد؛ انتخاب دستی حفظ شده است.",
                );
            } catch (notifyError) {
                console.error(`Could not notify ${channelId}:`, notifyError);
            }
        }

        if (rotationSucceeded) delete state.forcedNext[channelId];
        state.candidates[channelId] = [];
    }

    state.cycleStartedAt = now;
    state.nextRotationAt = now + state.intervalMs;
    await saveState();
}

export async function registerRotationHandlers(bot: Telegraf, ownerId: number): Promise<void> {
    await loadState();

    for (const channelId of state.channels) {
        try {
            const chat = await bot.telegram.getChat(channelId);
            if (chat.type === "channel" && chat.linked_chat_id !== undefined) {
                state.discussionGroups[String(chat.linked_chat_id)] = channelId;
            }
        } catch (error) {
            console.error(`Could not load linked discussion group for ${channelId}:`, error);
        }
    }
    await saveState();

    bot.start(async (ctx) => {
        if (!isOwner(ownerId, ctx.from?.id)) return;
        pendingInputs.delete(ownerId);
        await ctx.reply(dashboardText(), dashboardKeyboard());
    });

    bot.action("dashboard", async (ctx) => {
        if (!isOwner(ownerId, ctx.from?.id)) return ctx.answerCbQuery("دسترسی ندارید.", { show_alert: true });
        await ctx.answerCbQuery();
        try {
            await ctx.editMessageText(dashboardText(), dashboardKeyboard());
        } catch (error) {
            if (!(error instanceof Error) || !error.message.includes("message is not modified")) throw error;
        }
    });

    bot.action("rotation_toggle", async (ctx) => {
        if (!isOwner(ownerId, ctx.from?.id)) return ctx.answerCbQuery("دسترسی ندارید.", { show_alert: true });
        if (!state.active && !state.channels.length) {
            await ctx.answerCbQuery("اول کانال‌ها را ثبت کنید.", { show_alert: true });
            return;
        }
        if (state.active) {
            state.active = false;
            state.nextRotationAt = null;
        } else {
            state.active = true;
            state.cycleStartedAt = Date.now();
            state.nextRotationAt = Date.now() + state.intervalMs;
        }
        await saveState();
        await ctx.answerCbQuery(state.active ? "چرخه فعال شد." : "چرخه متوقف شد.");
        await ctx.editMessageText(dashboardText(), dashboardKeyboard());
    });

    bot.action("channels_menu", async (ctx) => {
        if (!isOwner(ownerId, ctx.from?.id)) return ctx.answerCbQuery("دسترسی ندارید.", { show_alert: true });
        await ctx.answerCbQuery();
        const channels = state.channels.length ? state.channels.map(channelLabel).join("\n") : "هنوز کانالی ثبت نشده است.";
        await ctx.editMessageText(
            `کانال‌های ثبت‌شده:\n${channels}\n\nبرای جایگزینی فهرست، دکمهٔ زیر را بزنید.`,
            Markup.inlineKeyboard([
                [Markup.button.callback("✏️ تنظیم فهرست کانال‌ها", "channels_set")],
                [Markup.button.callback("⬅️ بازگشت", "dashboard")],
            ]),
        );
    });

    bot.action("channels_set", async (ctx) => {
        if (!isOwner(ownerId, ctx.from?.id)) return ctx.answerCbQuery("دسترسی ندارید.", { show_alert: true });
        pendingInputs.set(ownerId, { type: "channels" });
        await ctx.answerCbQuery();
        await ctx.editMessageText(
            "آیدی عمومی کانال‌ها را با فاصله یا ویرگول بفرستید؛ مثلاً @channel1 @channel2",
            cancelInputKeyboard(),
        );
    });

    bot.action("interval_menu", async (ctx) => {
        if (!isOwner(ownerId, ctx.from?.id)) return ctx.answerCbQuery("دسترسی ندارید.", { show_alert: true });
        await ctx.answerCbQuery();
        await ctx.editMessageText(
            `بازهٔ فعلی: ${formatInterval(state.intervalMs)}\nیک بازه انتخاب کنید:`,
            Markup.inlineKeyboard([
                [
                    Markup.button.callback("🧪 تست: هر ۱۰ ثانیه", "interval_test:10"),
                    Markup.button.callback("🧪 تست: هر ۲۰ ثانیه", "interval_test:20"),
                ],
                [1, 2, 3].map((hours) => Markup.button.callback(`${hours} ساعت`, `interval_set:${hours}`)),
                [6, 12, 24].map((hours) => Markup.button.callback(`${hours} ساعت`, `interval_set:${hours}`)),
                [Markup.button.callback("سفارشی", "interval_custom")],
                [Markup.button.callback("⬅️ بازگشت", "dashboard")],
            ]),
        );
    });

    bot.action(/^interval_test:(10|20)$/, async (ctx) => {
        if (!isOwner(ownerId, ctx.from?.id)) return ctx.answerCbQuery("دسترسی ندارید.", { show_alert: true });
        const seconds = Number(ctx.match[1]);
        state.intervalMs = seconds * 1000;
        if (state.active) {
            state.cycleStartedAt = Date.now();
            state.nextRotationAt = Date.now() + state.intervalMs;
        }
        await saveState();
        await ctx.answerCbQuery(state.active ? `تست فعال: اجرای بعدی تا ${seconds} ثانیهٔ دیگر.` : `بازهٔ تست روی ${seconds} ثانیه تنظیم شد.`);
        await ctx.editMessageText(dashboardText(), dashboardKeyboard());
    });

    bot.action(/^interval_set:(\d+(?:\.\d+)?)$/, async (ctx) => {
        if (!isOwner(ownerId, ctx.from?.id)) return ctx.answerCbQuery("دسترسی ندارید.", { show_alert: true });
        const hours = Number(ctx.match[1]);
        state.intervalMs = hours * 3_600_000;
        if (state.active) {
            state.cycleStartedAt = Date.now();
            state.nextRotationAt = Date.now() + state.intervalMs;
        }
        await saveState();
        await ctx.answerCbQuery(`بازه روی ${hours} ساعت تنظیم شد.`);
        await ctx.editMessageText(dashboardText(), dashboardKeyboard());
    });

    bot.action("interval_custom", async (ctx) => {
        if (!isOwner(ownerId, ctx.from?.id)) return ctx.answerCbQuery("دسترسی ندارید.", { show_alert: true });
        pendingInputs.set(ownerId, { type: "interval" });
        await ctx.answerCbQuery();
        await ctx.editMessageText("مدت را به ساعت وارد کنید (مثلاً 1.5؛ حداکثر ۷۲۰ ساعت).", cancelInputKeyboard());
    });

    bot.action("force_menu", async (ctx) => {
        if (!isOwner(ownerId, ctx.from?.id)) return ctx.answerCbQuery("دسترسی ندارید.", { show_alert: true });
        await ctx.answerCbQuery();
        if (!state.channels.length) {
            await ctx.editMessageText("ابتدا از بخش کانال‌ها، کانال موردنظر را ثبت کنید.", dashboardKeyboard());
            return;
        }
        await ctx.editMessageText("برای کدام کانال، نفر بعدی را دستی تعیین می‌کنید؟", channelSelectionKeyboard("force"));
    });

    bot.action(/^force:(-?\d+)$/, async (ctx) => {
        if (!isOwner(ownerId, ctx.from?.id)) return ctx.answerCbQuery("دسترسی ندارید.", { show_alert: true });
        const channelId = ctx.match[1];
        if (!state.channels.includes(channelId)) return ctx.answerCbQuery("این کانال ثبت نشده است.", { show_alert: true });
        pendingInputs.set(ownerId, { type: "forced_user", channelId });
        await ctx.answerCbQuery();
        await ctx.editMessageText(`آیدی عددی کاربر برای ${channelLabel(channelId)} را بفرستید.`, cancelInputKeyboard());
    });

    bot.action("clear_force_menu", async (ctx) => {
        if (!isOwner(ownerId, ctx.from?.id)) return ctx.answerCbQuery("دسترسی ندارید.", { show_alert: true });
        await ctx.answerCbQuery();
        const channelsWithOverride = state.channels.filter((channelId) => state.forcedNext[channelId] !== undefined);
        if (!channelsWithOverride.length) {
            await ctx.editMessageText("انتخاب دستی فعالی ثبت نشده است.", dashboardKeyboard());
            return;
        }
        await ctx.editMessageText(
            "انتخاب دستی کدام کانال پاک شود؟",
            Markup.inlineKeyboard([
                ...channelsWithOverride.map((channelId) => [
                    Markup.button.callback(`🧹 ${channelLabel(channelId)}`, `clear_force:${channelId}`),
                ]),
                [Markup.button.callback("⬅️ بازگشت", "dashboard")],
            ]),
        );
    });

    bot.action(/^clear_force:(-?\d+)$/, async (ctx) => {
        if (!isOwner(ownerId, ctx.from?.id)) return ctx.answerCbQuery("دسترسی ندارید.", { show_alert: true });
        delete state.forcedNext[ctx.match[1]];
        await saveState();
        await ctx.answerCbQuery("انتخاب دستی پاک شد.");
        await ctx.editMessageText(dashboardText(), dashboardKeyboard());
    });

    bot.action("cancel_input", async (ctx) => {
        if (!isOwner(ownerId, ctx.from?.id)) return ctx.answerCbQuery("دسترسی ندارید.", { show_alert: true });
        pendingInputs.delete(ownerId);
        await ctx.answerCbQuery("لغو شد.");
        await ctx.editMessageText(dashboardText(), dashboardKeyboard());
    });

    bot.on("message", async (ctx) => {
        const message = ctx.message;
        const userId = message.from?.id;

        if (ctx.chat.type === "private" && isOwner(ownerId, userId) && "text" in message) {
            const pending = pendingInputs.get(ownerId);
            if (pending) {
                const input = normalizeDigits(message.text.trim());

                if (pending.type === "channels") {
                    const names = input.split(/[\s,]+/).filter(Boolean);
                    if (!names.length) {
                        await ctx.reply("حداقل یک آیدی عمومی کانال بفرستید.", cancelInputKeyboard());
                        return;
                    }

                    const resolved: string[] = [];
                    const discussionGroups: Record<string, string> = {};
                    for (const name of names) {
                        try {
                            const chat = await ctx.telegram.getChat(name);
                            if (chat.type !== "channel") throw new Error("Not a channel");
                            const channelId = String(chat.id);
                            resolved.push(channelId);
                            if (chat.linked_chat_id !== undefined) {
                                discussionGroups[String(chat.linked_chat_id)] = channelId;
                            }
                        } catch {
                            await ctx.reply(`کانال ${name} پیدا نشد یا ربات به آن دسترسی ندارد. دوباره بفرستید یا لغو کنید.`, cancelInputKeyboard());
                            return;
                        }
                    }
                    state.channels = [...new Set(resolved)];
                    state.discussionGroups = discussionGroups;
                } else if (pending.type === "interval") {
                    const hours = Number(input.replace(",", "."));
                    if (!Number.isFinite(hours) || hours <= 0 || hours > 720) {
                        await ctx.reply("یک عدد بیشتر از صفر و حداکثر ۷۲۰ ساعت وارد کنید.", cancelInputKeyboard());
                        return;
                    }
                    state.intervalMs = hours * 3_600_000;
                    if (state.active) {
                        state.cycleStartedAt = Date.now();
                        state.nextRotationAt = Date.now() + state.intervalMs;
                    }
                } else {
                    const forcedUserId = Number(input);
                    if (!Number.isSafeInteger(forcedUserId) || forcedUserId <= 0) {
                        await ctx.reply("آیدی عددی معتبر کاربر را وارد کنید.", cancelInputKeyboard());
                        return;
                    }
                    state.forcedNext[pending.channelId] = forcedUserId;
                }

                pendingInputs.delete(ownerId);
                await saveState();
                await ctx.reply(dashboardText(), dashboardKeyboard());
                return;
            }
        }

        if (!userId || message.sender_chat || message.from?.is_bot) {
            if (message.sender_chat || message.from?.is_bot) {
                console.info("[rotation] Anonymous/chat-sent comment ignored; Telegram did not provide a promotable user ID.");
            }
            return;
        }

        if (ctx.chat.type !== "supergroup" || !("reply_to_message" in message)) return;
        const repliedPost = message.reply_to_message;
        const channelId = state.discussionGroups[String(ctx.chat.id)];
        if (!repliedPost || !channelId) return;
        const list = state.candidates[channelId] ?? [];
        const postDate = repliedPost.date * 1000;
        if (!list.some((candidate) => candidate.userId === userId && candidate.postDate === postDate)) {
            list.push({ userId, postDate, commentDate: Date.now() });
            state.candidates[channelId] = list;
            await saveState();
            console.info(`[rotation] Commenter recorded for channel ${channelId}; unique participants: ${new Set(list.map((candidate) => candidate.userId)).size}`);
        }
    });

    setInterval(() => {
        if (!isRotating && state.active && state.nextRotationAt !== null && Date.now() >= state.nextRotationAt) {
            isRotating = true;
            void rotate(bot, Date.now())
                .catch((error) => console.error("Rotation cycle failed:", error))
                .finally(() => { isRotating = false; });
        }
    }, 1_000).unref();
}