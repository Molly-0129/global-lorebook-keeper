import test from 'node:test';
import assert from 'node:assert/strict';
import { registerStEnv } from '../src/st-env.js';
import { applyCurrentChatBinding } from '../src/core.js';
import { currentChat, readChatBinding } from '../src/chat.js';
import { beginPromptCapture } from '../src/capture.js';

test('captures live flags for one chat and restores native switches', async () => {
    let chatId = 'scene';
    let characters = [{ avatar: 'fox.png' }];
    let preset = 'Story';
    let metadataSaves = 0;
    const metadata = { globalLorebookKeeper: { mode: 'preset', apiId: 'openai', preset, prompts: { first: false }, lorebooks: ['World'] } };
    const order = [{ identifier: 'first', enabled: true }, { identifier: 'third', enabled: false }];
    const defaults = order.map(entry => ({ ...entry }));
    const manager = { activeCharacter: { id: 100001 }, getPromptOrderForCharacter: () => order };
    const pm = {
        apiId: 'openai',
        getSelectedPresetName: () => preset,
        getCompletionPresetByName: () => ({ prompt_order: [{ character_id: 100001, order: defaults }] }),
        findPreset: name => name,
        async selectPreset(name) { preset = name; },
    };
    registerStEnv({
        getContextFn: () => ({
            characters, characterId: 0, chatId, chatMetadata: metadata, saveSettingsDebounced() {},
            async saveMetadata() { metadataSaves++; },
        }),
        getPresetManagerFn: () => pm,
        extensionSettingsObj: {},
    });

    const capture = beginPromptCapture(manager);
    assert.equal(order[0].enabled, false);
    order[0].enabled = true;
    order[1].enabled = true;
    await capture.confirm();
    assert.deepEqual(order, defaults);
    assert.deepEqual(readChatBinding().prompts, { third: true });
    assert.deepEqual(readChatBinding().lorebooks, ['World']);
    assert.equal(metadataSaves, 1);

    const cancelled = beginPromptCapture(manager);
    order[0].enabled = false;
    cancelled.restore();
    assert.deepEqual(order, defaults);
    assert.equal(metadataSaves, 1);

    const stale = beginPromptCapture(manager);
    chatId = 'another-scene';
    await assert.rejects(stale.confirm(), /已切换/);
    assert.deepEqual(order, defaults);
    assert.equal(metadataSaves, 1);

    const deleted = beginPromptCapture(manager);
    characters = [];
    assert.equal(currentChat(), null);
    await assert.rejects(deleted.confirm(), /已切换/);
    assert.equal(metadataSaves, 1);
    assert.throws(() => beginPromptCapture(manager), /请先打开一条聊天/);
});

test('the binding flow tolerates an empty host and a deleted character', async () => {
    let characters = [];
    let chatId;
    let selected = 'Manual';
    const settings = { '角色-预设-世界书绑定器': { presetBinderSettings: { version: 2, characterPresetBindings: { 'fox.png': 'Story' } } } };
    const pm = { apiId: 'openai', getSelectedPresetName: () => selected, findPreset: name => name, async selectPreset(name) { selected = name; } };
    registerStEnv({
        getContextFn: () => ({ characters, characterId: 0, chatId, chatMetadata: {} }),
        getPresetManagerFn: () => pm,
        getWorldNamesFn: () => [],
        extensionSettingsObj: settings,
    });
    await applyCurrentChatBinding();
    assert.equal(selected, 'Manual');
    assert.throws(() => beginPromptCapture(undefined), /请先打开一条聊天/);

    characters = [{ avatar: 'fox.png' }];
    chatId = 'old-chat-id';
    await applyCurrentChatBinding();
    assert.equal(selected, 'Story');

    characters = [];
    await applyCurrentChatBinding();
    assert.equal(selected, 'Manual');
});
