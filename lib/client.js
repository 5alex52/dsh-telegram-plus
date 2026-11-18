"use strict";
/**
 * Browser half of dsh-telegram-notify: a dedicated Settings section where the
 * bot token, chat id and event toggles live.
 *
 * This file is a client-module bundle, not an ES module. The browser loader
 * evaluates the `factory` and reads `apply`/`inject` off the exports object;
 * any top-level import or export (type-only included) would make TypeScript
 * emit a module and the loader would reject it. All React access therefore
 * arrives through the loader's `require`, and every helper lives in the
 * factory closure.
 */
window.__ModuleLoader__.load({
    id: 'dsh-telegram-plus',
    factory: (require) => {
        const React = require('react');
        const module = { exports: {} };
        const exports = module.exports;
        const h = React.createElement;
        /** Locale namespace for this section's copy. */
        const NS = 'settings.telegram';
        /** Settings namespace of the Host plugin: its loader row id. */
        const SETTINGS_NS = 'telegram-plus';
        /** Must match the Host plugin's `tokenRef` default. */
        const DEFAULT_REF = 'TELEGRAM_BOT_TOKEN';
        const TOKEN_REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
        const BOT_TOKEN_PATTERN = /^\d+:[A-Za-z0-9_-]{20,}$/;
        const CHAT_ID_PATTERN = /^-?\d+$/;
        const CHANNEL_PATTERN = /^@[A-Za-z][A-Za-z0-9_]{4,31}$/;
        const COPY = {
            en: {
                nav: 'Telegram',
                title: 'Telegram notifications',
                intro: 'Send a Telegram message when a DSH turn needs your attention. With “Reply from Telegram” on, the bot also reads button presses and chat replies so a pending question can be answered without opening DSH.',
                connection: 'Connection',
                tokenLabel: 'Bot token',
                tokenHint: 'Stored in the DSH credential store under the reference below. It is never written to the plugin configuration.',
                tokenPlaceholder: '123456789:AA…',
                tokenConfigured: 'Configured',
                tokenMissing: 'Not configured',
                tokenChecking: 'Checking…',
                tokenReadOnly: 'This credential comes from a read-only source and cannot be changed here.',
                tokenUnavailable: 'The credential store is not reachable. Reload once DSH has finished starting.',
                tokenUnavailableShort: 'Unavailable',
                saveToken: 'Save token',
                savingToken: 'Saving…',
                removeToken: 'Remove',
                tokenSaved: 'Token saved.',
                tokenRemoved: 'Token removed.',
                tokenInvalid: 'That does not look like a Telegram bot token.',
                tokenSaveFailed: 'Could not save the token: %s',
                tokenRemoveFailed: 'Could not remove the token: %s',
                tokenDescribeFailed: 'Could not read the token status.',
                chatIdLabel: 'Chat id',
                chatIdHint: 'Numeric chat id (negative for groups) or @channelusername. Send the bot a message first if you do not know it.',
                chatIdPlaceholder: '123456789',
                chatIdInvalid: 'Enter a numeric chat id or an @channelusername.',
                refLabel: 'Credential reference',
                refHint: 'Where the bot token is stored. Save settings after changing this, then save the token for the new reference.',
                refInvalid: 'Use letters, digits and underscores, starting with a letter or underscore.',
                events: 'Events',
                eventsHint: 'Choose which moments send a message. Subagent sessions are always ignored.',
                evTurn: 'Turn completed',
                evTurnHint: 'The agent answered and the turn ended.',
                evError: 'Turn failed',
                evErrorHint: 'Provider errors, blocked turns and output-token stops.',
                evAborted: 'Turn cancelled',
                evAbortedHint: 'A turn was stopped before it finished.',
                evQuestion: 'Waiting for input',
                evQuestionHint: 'The agent asked a question and is waiting for your answer.',
                evReplies: 'Reply from Telegram',
                evRepliesHint: 'Post a pending question with buttons and accept the answer from this chat.',
                evPlan: 'Plan ready for review',
                evPlanHint: 'A plan is waiting for approval.',
                evApproval: 'Approval needed',
                evApprovalHint: 'A tool needs your approval — Allow once / Reject buttons arrive in the chat.',
                delivery: 'Delivery',
                silent: 'Silent notifications',
                silentHint: 'Send without a notification sound.',
                save: 'Save settings',
                saving: 'Saving…',
                revert: 'Revert',
                saved: 'Settings saved.',
                saveFailed: 'Could not save settings. Reload and try again.',
                unsaved: 'Unsaved changes',
                loading: 'Loading settings…',
                unavailable: 'The Telegram plugin is not loaded in this deployment, so there is nothing to configure.',
                readonly: 'This profile is read-only; settings cannot be changed here.',
                footerHint: 'Settings apply to the next turn. Messages use Telegram HTML formatting, and replies are only read from a private chat id.',
                noChat: 'No chat id is set yet. The plugin stays idle until one is saved.',
            },
        };
        const styles = {
            section: {
                display: 'flex',
                flexDirection: 'column',
                gap: '16px',
                maxWidth: '760px',
                color: 'var(--dsw-alias-label-primary)',
            },
            heading: { margin: 0, fontSize: '18px', fontWeight: 600, lineHeight: 1.4 },
            intro: { margin: 0, fontSize: '13px', lineHeight: 1.6, color: 'var(--dsw-alias-label-tertiary)' },
            card: {
                display: 'flex',
                flexDirection: 'column',
                gap: '14px',
                padding: '16px',
                borderRadius: 'var(--dsw-radius-md)',
                border: '1px solid var(--dsw-alias-settings-card-stroke)',
                background: 'var(--dsw-alias-settings-card-fill)',
            },
            cardTitle: { margin: 0, fontSize: '14px', fontWeight: 600 },
            field: { display: 'flex', flexDirection: 'column', gap: '6px' },
            labelRow: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
            label: { fontSize: '13px', fontWeight: 500 },
            hint: { margin: 0, fontSize: '12px', lineHeight: 1.5, color: 'var(--dsw-alias-label-tertiary)' },
            badge: (ok, unknownState) => ({
                padding: '1px 7px',
                borderRadius: '999px',
                fontSize: '11px',
                lineHeight: '18px',
                color: unknownState
                    ? 'var(--dsw-alias-label-secondary)'
                    : ok
                        ? 'var(--dsw-alias-state-success-primary)'
                        : 'var(--dsw-alias-label-tertiary)',
                border: `1px solid ${unknownState
                    ? 'var(--dsw-alias-border-l2)'
                    : ok
                        ? 'var(--dsw-alias-state-success-primary)'
                        : 'var(--dsw-alias-border-l2)'}`,
            }),
            input: {
                boxSizing: 'border-box',
                minWidth: 0,
                padding: '7px 10px',
                fontSize: '13px',
                fontFamily: 'inherit',
                color: 'var(--dsw-alias-label-primary)',
                background: 'var(--dsw-alias-bg-base)',
                border: '1px solid var(--dsw-alias-border-l2)',
                borderRadius: 'var(--dsw-radius-sm)',
            },
            inputRow: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' },
            button: (primary, disabled) => ({
                padding: '6px 12px',
                fontSize: '12px',
                fontFamily: 'inherit',
                color: primary
                    ? 'var(--dsw-alias-label-primary-foreground)'
                    : 'var(--dsw-alias-label-primary)',
                background: primary ? 'var(--dsw-alias-button-primary-fill)' : 'var(--dsw-alias-bg-layer-2)',
                border: `1px solid ${primary ? 'var(--dsw-alias-button-primary-fill)' : 'var(--dsw-alias-border-l2)'}`,
                borderRadius: 'var(--dsw-radius-sm)',
                cursor: disabled ? 'not-allowed' : 'pointer',
                opacity: disabled ? 0.55 : 1,
            }),
            toggleRow: {
                display: 'flex',
                alignItems: 'flex-start',
                justifyContent: 'space-between',
                gap: '12px',
            },
            toggleText: { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 },
            toggleLabel: { fontSize: '13px' },
            switch: (on, disabled) => ({
                position: 'relative',
                flex: '0 0 auto',
                width: '34px',
                height: '20px',
                padding: 0,
                border: `1px solid ${on ? 'var(--dsw-alias-state-business-primary)' : 'var(--dsw-alias-border-l2)'}`,
                borderRadius: '999px',
                background: on ? 'var(--dsw-alias-state-business-primary)' : 'var(--dsw-alias-bg-layer-2)',
                cursor: disabled ? 'not-allowed' : 'pointer',
                opacity: disabled ? 0.55 : 1,
                marginTop: '1px',
                transition: 'background 120ms ease, border-color 120ms ease',
            }),
            knob: (on) => ({
                position: 'absolute',
                top: '2px',
                left: on ? '17px' : '2px',
                width: '14px',
                height: '14px',
                borderRadius: '50%',
                background: on ? 'var(--dsw-alias-label-primary-foreground)' : 'var(--dsw-alias-label-tertiary)',
                transition: 'left 120ms ease, background 120ms ease',
            }),
            footer: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
            error: { margin: 0, fontSize: '12px', lineHeight: 1.5, color: 'var(--dsw-alias-state-error-primary)' },
            ok: { margin: 0, fontSize: '12px', lineHeight: 1.5, color: 'var(--dsw-alias-state-success-primary)' },
            notice: {
                margin: 0,
                padding: '10px 12px',
                borderRadius: 'var(--dsw-radius-sm)',
                background: 'var(--dsw-alias-bg-layer-2)',
                color: 'var(--dsw-alias-label-secondary)',
                fontSize: '12px',
                lineHeight: 1.5,
            },
        };
        function messageOf(error) {
            return error instanceof Error ? error.message : String(error);
        }
        function fill(template, value) {
            return template.replace('%s', value);
        }
        function toDraft(value) {
            const source = value ?? {};
            return {
                chatId: typeof source.chatId === 'string' || typeof source.chatId === 'number' ? String(source.chatId) : '',
                tokenRef: typeof source.tokenRef === 'string' && source.tokenRef.trim() !== '' ? source.tokenRef.trim() : DEFAULT_REF,
                notifyTurnComplete: source.notifyTurnComplete !== false,
                notifyTurnError: source.notifyTurnError !== false,
                notifyTurnAborted: source.notifyTurnAborted === true,
                notifyQuestions: source.notifyQuestions !== false,
                allowReplies: source.allowReplies !== false,
                notifyPlanReviews: source.notifyPlanReviews !== false,
                notifyApprovals: source.notifyApprovals !== false,
                silent: source.silent === true,
            };
        }
        function chatIdProblem(value) {
            const text = value.trim();
            if (text === '')
                return false;
            return !CHAT_ID_PATTERN.test(text) && !CHANNEL_PATTERN.test(text);
        }
        function credentialsApi(ctx) {
            // The remote namespaces are resolved lazily: a client plugin may apply
            // before every remote is attached, and the page is usable once one is.
            const current = () => ctx.remote?.credentials;
            return {
                async describe(ref) {
                    const remote = current();
                    if (ref === '' || typeof remote?.describe !== 'function') {
                        return { configured: false, writable: true, unavailable: true, error: 'no credential remote' };
                    }
                    try {
                        const response = await remote.describe([ref]);
                        if (response?.ok !== true) {
                            return {
                                configured: false,
                                writable: true,
                                unavailable: true,
                                error: response?.error?.message ?? 'credential description failed',
                            };
                        }
                        const state = response.value?.[ref];
                        return {
                            configured: state?.configured === true,
                            writable: state?.writable !== false,
                            unavailable: state?.unavailable === true,
                        };
                    }
                    catch (error) {
                        return { configured: false, writable: true, unavailable: true, error: messageOf(error) };
                    }
                },
                async set(ref, value) {
                    const remote = current();
                    if (typeof remote?.set !== 'function')
                        return { ok: false, error: 'credential writes are unavailable' };
                    try {
                        const response = await remote.set(ref, value);
                        return { ok: response?.ok === true, error: response?.error?.message };
                    }
                    catch (error) {
                        return { ok: false, error: messageOf(error) };
                    }
                },
                async unset(ref) {
                    const remote = current();
                    if (typeof remote?.unset !== 'function')
                        return { ok: false, error: 'credential writes are unavailable' };
                    try {
                        const response = await remote.unset(ref);
                        return { ok: response?.ok === true, error: response?.error?.message };
                    }
                    catch (error) {
                        return { ok: false, error: messageOf(error) };
                    }
                },
                subscribe(handler) {
                    // Call through the remote object: `$on` reads its own context, so a
                    // detached function loses `this`.
                    const remote = ctx.remote;
                    if (typeof remote?.$on !== 'function')
                        return () => { };
                    const off = remote.$on('credentials/reference-updated', (value) => {
                        if (typeof value === 'string')
                            handler(value);
                    });
                    return typeof off === 'function' ? off : () => { };
                },
            };
        }
        function Toggle(props) {
            return h('button', {
                type: 'button',
                role: 'switch',
                'aria-checked': props.checked,
                'aria-label': props.label,
                disabled: props.disabled,
                onClick: () => props.onChange(!props.checked),
                style: styles.switch(props.checked, props.disabled),
            }, h('span', { 'aria-hidden': true, style: styles.knob(props.checked) }));
        }
        function TelegramSettingsSection(props) {
            const t = typeof props.t === 'function' ? props.t : (key) => (COPY.en[key] ?? key);
            const store = props.store;
            const snapshot = React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
            const [draft, setDraft] = React.useState(() => snapshot.status === 'ready' && snapshot.value !== undefined ? toDraft(snapshot.value) : null);
            const [saveState, setSaveState] = React.useState('idle');
            const [saveError, setSaveError] = React.useState(null);
            const [tokenText, setTokenText] = React.useState('');
            const [tokenBusy, setTokenBusy] = React.useState(false);
            const [tokenNotice, setTokenNotice] = React.useState(null);
            const [tokenError, setTokenError] = React.useState(null);
            const [tokenState, setTokenState] = React.useState({
                configured: false,
                writable: true,
            });
            const [tokenLoaded, setTokenLoaded] = React.useState(false);
            React.useEffect(() => {
                if (snapshot.status === 'ready' && snapshot.value !== undefined && draft === null) {
                    setDraft(toDraft(snapshot.value));
                }
            }, [snapshot.status, snapshot.revision, draft]);
            const saved = snapshot.status === 'ready' && snapshot.value !== undefined ? toDraft(snapshot.value) : null;
            const savedRef = saved?.tokenRef ?? DEFAULT_REF;
            const dirty = draft !== null && saved !== null && JSON.stringify(draft) !== JSON.stringify(saved);
            const ready = snapshot.status === 'ready' && draft !== null;
            const writable = snapshot.writable !== false;
            const disabled = !ready || !writable || saveState === 'saving';
            React.useEffect(() => {
                let live = true;
                setTokenLoaded(false);
                const load = () => {
                    const api = props.credentials;
                    if (api === undefined) {
                        if (live) {
                            setTokenState({ configured: false, writable: false, unavailable: true });
                            setTokenLoaded(true);
                        }
                        return;
                    }
                    void api.describe(savedRef).then((state) => {
                        if (!live)
                            return;
                        setTokenState(state);
                        setTokenLoaded(true);
                    });
                };
                load();
                const off = props.credentials?.subscribe((ref) => {
                    if (ref === savedRef)
                        load();
                });
                return () => {
                    live = false;
                    off?.();
                };
            }, [savedRef, props.credentials]);
            const edit = (patch) => {
                setDraft((current) => (current === null ? current : { ...current, ...patch }));
                setSaveState('idle');
                setSaveError(null);
            };
            const save = () => {
                if (!ready || !writable || draft === null || saved === null)
                    return;
                if (chatIdProblem(draft.chatId)) {
                    setSaveState('error');
                    setSaveError(t('chatIdInvalid'));
                    return;
                }
                const tokenRef = draft.tokenRef.trim() || DEFAULT_REF;
                if (!TOKEN_REF_PATTERN.test(tokenRef)) {
                    setSaveState('error');
                    setSaveError(t('refInvalid'));
                    return;
                }
                const ops = [];
                const push = (field, value) => {
                    if (JSON.stringify(saved[field]) !== JSON.stringify(value)) {
                        ops.push({ op: 'set', path: [field], value });
                    }
                };
                push('chatId', draft.chatId.trim());
                push('tokenRef', tokenRef);
                push('notifyTurnComplete', draft.notifyTurnComplete);
                push('notifyTurnError', draft.notifyTurnError);
                push('notifyTurnAborted', draft.notifyTurnAborted);
                push('notifyQuestions', draft.notifyQuestions);
                push('allowReplies', draft.allowReplies);
                push('notifyPlanReviews', draft.notifyPlanReviews);
                push('notifyApprovals', draft.notifyApprovals);
                push('silent', draft.silent);
                if (ops.length === 0) {
                    setSaveState('saved');
                    return;
                }
                setSaveState('saving');
                setSaveError(null);
                void props.form.mutate(ops).then((ok) => {
                    setSaveState(ok ? 'saved' : 'error');
                    if (!ok)
                        setSaveError(t('saveFailed'));
                }, () => {
                    setSaveState('error');
                    setSaveError(t('saveFailed'));
                });
            };
            const revert = () => {
                if (saved !== null) {
                    setDraft(saved);
                    setSaveState('idle');
                    setSaveError(null);
                }
            };
            const saveToken = () => {
                const value = tokenText.trim();
                if (!BOT_TOKEN_PATTERN.test(value)) {
                    setTokenError(t('tokenInvalid'));
                    return;
                }
                const api = props.credentials;
                if (api === undefined) {
                    setTokenError(t('tokenUnavailable'));
                    return;
                }
                setTokenBusy(true);
                setTokenError(null);
                setTokenNotice(null);
                void api.set(savedRef, value).then((result) => {
                    if (!result.ok) {
                        setTokenError(fill(t('tokenSaveFailed'), result.error ?? 'unknown'));
                        return;
                    }
                    setTokenText('');
                    setTokenNotice(t('tokenSaved'));
                    void api.describe(savedRef).then((state) => setTokenState(state), () => { });
                }, (error) => setTokenError(fill(t('tokenSaveFailed'), messageOf(error)))).finally(() => setTokenBusy(false));
            };
            const removeToken = () => {
                const api = props.credentials;
                if (api === undefined) {
                    setTokenError(t('tokenUnavailable'));
                    return;
                }
                setTokenBusy(true);
                setTokenError(null);
                setTokenNotice(null);
                void api.unset(savedRef).then((result) => {
                    if (!result.ok) {
                        setTokenError(fill(t('tokenRemoveFailed'), result.error ?? 'unknown'));
                        return;
                    }
                    setTokenText('');
                    setTokenNotice(t('tokenRemoved'));
                    void api.describe(savedRef).then((state) => setTokenState(state), () => { });
                }, (error) => setTokenError(fill(t('tokenRemoveFailed'), messageOf(error)))).finally(() => setTokenBusy(false));
            };
            const tokenBadge = tokenState.unavailable
                ? t('tokenUnavailableShort')
                : tokenLoaded
                    ? tokenState.configured
                        ? t('tokenConfigured')
                        : t('tokenMissing')
                    : t('tokenChecking');
            const tokenWritable = tokenState.writable !== false && tokenState.unavailable !== true;
            const tokenDisabled = tokenBusy || !tokenWritable;
            const eventRows = [
                { key: 'notifyTurnComplete', label: t('evTurn'), hint: t('evTurnHint') },
                { key: 'notifyTurnError', label: t('evError'), hint: t('evErrorHint') },
                { key: 'notifyTurnAborted', label: t('evAborted'), hint: t('evAbortedHint') },
                { key: 'notifyQuestions', label: t('evQuestion'), hint: t('evQuestionHint') },
                { key: 'allowReplies', label: t('evReplies'), hint: t('evRepliesHint') },
                { key: 'notifyPlanReviews', label: t('evPlan'), hint: t('evPlanHint') },
                { key: 'notifyApprovals', label: t('evApproval'), hint: t('evApprovalHint') },
            ];
            if (snapshot.status === 'unavailable') {
                return h('section', { style: styles.section }, h('h2', { style: styles.heading }, t('title')), h('p', { style: styles.notice }, t('unavailable')));
            }
            if (!ready || draft === null) {
                return h('section', { style: styles.section }, h('h2', { style: styles.heading }, t('title')), h('p', { style: styles.hint }, t('loading')));
            }
            return h('section', { style: styles.section }, h('div', null, h('h2', { style: styles.heading }, t('title')), h('p', { style: styles.intro }, t('intro'))), !writable ? h('p', { style: styles.notice }, t('readonly')) : null, h('div', { style: styles.card, role: 'group', 'aria-label': t('connection') }, h('h3', { style: styles.cardTitle }, t('connection')), h('div', { style: styles.field }, h('div', { style: styles.labelRow }, h('label', { htmlFor: 'tg-token-input', style: styles.label }, t('tokenLabel')), h('span', { style: styles.badge(tokenState.configured, !tokenLoaded) }, tokenBadge)), h('p', { style: styles.hint }, t('tokenHint')), h('div', { style: styles.inputRow }, h('input', {
                id: 'tg-token-input',
                type: 'password',
                autoComplete: 'off',
                spellCheck: false,
                value: tokenText,
                placeholder: t('tokenPlaceholder'),
                disabled: tokenDisabled,
                onChange: (event) => setTokenText(event.target.value),
                style: { ...styles.input, flex: '1 1 220px' },
                'aria-label': t('tokenLabel'),
            }), h('button', {
                type: 'button',
                disabled: tokenDisabled || tokenText.trim() === '',
                onClick: saveToken,
                style: styles.button(true, tokenDisabled || tokenText.trim() === ''),
            }, tokenBusy ? t('savingToken') : t('saveToken')), tokenState.configured && tokenWritable
                ? h('button', {
                    type: 'button',
                    disabled: tokenBusy,
                    onClick: removeToken,
                    style: styles.button(false, tokenBusy),
                }, t('removeToken'))
                : null), !tokenWritable && tokenLoaded
                ? h('p', { style: styles.hint }, tokenState.unavailable ? t('tokenUnavailable') : t('tokenReadOnly'))
                : null, tokenNotice === null ? null : h('p', { style: styles.ok }, tokenNotice), tokenError === null ? null : h('p', { style: styles.error }, tokenError)), h('div', { style: styles.field }, h('label', { htmlFor: 'tg-chat-id', style: styles.label }, t('chatIdLabel')), h('input', {
                id: 'tg-chat-id',
                type: 'text',
                value: draft.chatId,
                placeholder: t('chatIdPlaceholder'),
                disabled: !writable,
                onChange: (event) => edit({ chatId: event.target.value }),
                style: styles.input,
            }), h('p', { style: styles.hint }, t('chatIdHint')), draft.chatId.trim() === '' ? h('p', { style: styles.hint }, t('noChat')) : null), h('div', { style: styles.field }, h('label', { htmlFor: 'tg-token-ref', style: styles.label }, t('refLabel')), h('input', {
                id: 'tg-token-ref',
                type: 'text',
                value: draft.tokenRef,
                spellCheck: false,
                disabled: !writable,
                onChange: (event) => edit({ tokenRef: event.target.value }),
                style: styles.input,
            }), h('p', { style: styles.hint }, t('refHint')))), h('div', { style: styles.card, role: 'group', 'aria-label': t('events') }, h('h3', { style: styles.cardTitle }, t('events')), h('p', { style: styles.hint }, t('eventsHint')), ...eventRows.map((row) => h('div', { key: row.key, style: styles.toggleRow }, h('div', { style: styles.toggleText }, h('span', { style: styles.toggleLabel }, row.label), h('span', { style: styles.hint }, row.hint)), Toggle({
                checked: draft[row.key] === true,
                disabled: !writable,
                label: row.label,
                onChange: (next) => edit({ [row.key]: next }),
            })))), h('div', { style: styles.card, role: 'group', 'aria-label': t('delivery') }, h('h3', { style: styles.cardTitle }, t('delivery')), h('div', { style: styles.toggleRow }, h('div', { style: styles.toggleText }, h('span', { style: styles.toggleLabel }, t('silent')), h('span', { style: styles.hint }, t('silentHint'))), Toggle({
                checked: draft.silent,
                disabled: !writable,
                label: t('silent'),
                onChange: (next) => edit({ silent: next }),
            }))), h('div', { style: styles.footer }, h('button', {
                type: 'button',
                disabled: disabled || !dirty,
                onClick: save,
                style: styles.button(true, disabled || !dirty),
            }, saveState === 'saving' ? t('saving') : t('save')), h('button', {
                type: 'button',
                disabled: disabled || !dirty,
                onClick: revert,
                style: styles.button(false, disabled || !dirty),
            }, t('revert')), saveState === 'saved' ? h('span', { style: styles.ok }, t('saved')) : null, saveState === 'error' ? h('span', { style: styles.error }, saveError ?? t('saveFailed')) : null, saveState === 'idle' && dirty ? h('span', { style: styles.hint }, t('unsaved')) : null), h('p', { style: styles.hint }, t('footerHint')));
        }
        const inject = ['slots', 'locale', 'configForms', 'remote', 'remote.credentials'];
        function apply(ctx) {
            const t = ctx.locale.bind(NS);
            ctx.effect(() => ctx.locale.register(NS, { en: COPY.en }), 'telegram-plus: locale');
            const form = ctx.configForms.get(SETTINGS_NS);
            const store = {
                getSnapshot: () => form.getSnapshot(),
                subscribe: (listener) => form.subscribe(listener),
            };
            const credentials = credentialsApi(ctx);
            ctx.slots.inject('settings.section', () => ctx.slots.register({
                name: 'settings.section',
                id: SETTINGS_NS,
                order: 30,
                label: () => t('nav'),
                locale: NS,
                inject: () => ({ t, form, store, credentials }),
            }, TelegramSettingsSection));
        }
        exports.apply = apply;
        exports.inject = inject;
        return module.exports;
    },
});
