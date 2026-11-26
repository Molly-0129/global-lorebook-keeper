import { currentChat, readChatBinding, resolvePreset, saveChatBinding } from './chat.js';
import { getActivePresetManager } from './st-env.js';

function liveOrder(manager) {
    if (!manager?.activeCharacter) return [];
    return manager.getPromptOrderForCharacter?.(manager.activeCharacter) || [];
}

export function beginPromptCapture(manager, pm = getActivePresetManager()) {
    const chat = currentChat();
    if (!chat) throw new Error('请先打开一条聊天。');

    const preset = pm?.apiId === 'openai' ? pm.getSelectedPresetName() : '';
    const definition = preset && pm.getCompletionPresetByName?.(preset);
    const defaults = definition?.prompt_order?.find(list => String(list.character_id) === String(manager?.activeCharacter?.id))?.order;
    const order = liveOrder(manager);
    if (!Array.isArray(defaults) || !defaults.length || !order.length) {
        throw new Error('请先选择并加载一套 Chat Completion 预设。');
    }

    const defaultFlags = new Map(defaults.map(entry => [entry.identifier, Boolean(entry.enabled)]));
    const originalFlags = new Map(order.map(entry => [entry.identifier, entry.enabled]));
    const binding = readChatBinding(chat);
    const matches = () => currentChat()?.key === chat.key
        && getActivePresetManager()?.apiId === 'openai'
        && pm.getSelectedPresetName() === preset;

    function restore() {
        const entries = matches() ? new Set([...order, ...liveOrder(manager)]) : new Set(order);
        let changed = false;
        for (const entry of entries) {
            if (!originalFlags.has(entry.identifier) || entry.enabled === originalFlags.get(entry.identifier)) continue;
            entry.enabled = originalFlags.get(entry.identifier);
            changed = true;
        }
        if (changed) chat.ctx.saveSettingsDebounced?.();
    }

    // Show the current chat's overrides as the starting point for editing.
    if (binding.preset === preset && binding.apiId === 'openai' && resolvePreset(binding, 'openai') === preset) {
        for (const entry of order) {
            if (Object.hasOwn(binding.prompts || {}, entry.identifier)) entry.enabled = binding.prompts[entry.identifier];
        }
    }

    return {
        matches,
        restore,
        async confirm() {
            if (!matches()) {
                restore();
                throw new Error('聊天或预设已切换，请重新开始记录。');
            }
            const prompts = Object.fromEntries(liveOrder(manager)
                .filter(entry => defaultFlags.has(entry.identifier) && Boolean(entry.enabled) !== defaultFlags.get(entry.identifier))
                .map(entry => [entry.identifier, Boolean(entry.enabled)]));
            const lorebooks = readChatBinding().lorebooks || [];
            restore();
            await saveChatBinding(chat, { mode: 'preset', apiId: 'openai', preset, prompts, lorebooks });
        },
    };
}

export function createCaptureControls(getManager, applyBinding) {
    let capture;
    let busy = false;
    let start;
    let confirm;
    let cancel;

    function refresh() {
        if (start) start.style.display = capture ? 'none' : '';
        if (confirm) confirm.style.display = capture ? '' : 'none';
        if (cancel) cancel.style.display = capture ? '' : 'none';
    }

    function renderManager() {
        const manager = getManager();
        Promise.resolve().then(() => manager?.render?.(false)).catch(error => console.warn('[LorebookKeeper]', error));
    }

    function stop() {
        if (!capture) return;
        capture.restore();
        capture = undefined;
        refresh();
        renderManager();
    }

    function mount() {
        const select = document.querySelector('#settings_preset_openai');
        if (!select || document.getElementById('lk-capture-controls')) return;
        const controls = document.createElement('span');
        controls.id = 'lk-capture-controls';
        controls.className = 'flex-container flexGap2';
        function button(icon, label, handler) {
            const element = document.createElement('button');
            element.type = 'button';
            element.className = 'menu_button';
            element.title = label;
            element.setAttribute('aria-label', label);
            element.innerHTML = `<i class="fa-solid ${icon}" aria-hidden="true"></i>`;
            element.addEventListener('click', handler);
            controls.appendChild(element);
            return element;
        }

        start = button('fa-link', '记录条目开关到当前聊天', () => {
            if (busy || capture) return;
            try {
                capture = beginPromptCapture(getManager());
                refresh();
                renderManager();
                toastr.info('调整条目开关后，点击勾号保存到当前聊天。');
            } catch (error) {
                toastr.warning(error.message);
            }
        });
        confirm = button('fa-check', '确认并保存聊天预设', async () => {
            if (busy || !capture) return;
            busy = true;
            const pending = capture;
            capture = undefined;
            refresh();
            try {
                await pending.confirm();
                await applyBinding();
                toastr.success('预设和条目开关已保存到当前聊天。');
            } catch (error) {
                toastr.error(error.message);
            } finally {
                busy = false;
                renderManager();
            }
        });
        cancel = button('fa-xmark', '取消记录条目开关', stop);
        select.after(controls);
        refresh();
    }

    return { mount, stop, stopIfChanged: () => { if (capture && !capture.matches()) stop(); } };
}
