// Global Lorebook Keeper - v1.5
// Original author: sleepyfish
// Enhanced with multi-preset binding groups, smart preset update inheritance & modernized UI

import { extension_settings, getContext } from '../../../extensions.js';
import { promptManager } from '../../../openai.js';
import { getPresetManager } from '../../../preset-manager.js';
import { selected_world_info, world_names } from '../../../world-info.js';

import {
    applyCurrentChatBinding,
    handleCharacterRenamed,
    handlePresetRenamed,
    handlePresetSelectChange,
    markPresetImportActivity,
    snapshotInitialPresets,
} from './src/core.js';
import { createCaptureControls } from './src/capture.js';
import { installPromptOverrides } from './src/chat.js';
import { mountExtensionEntries } from './src/panel.js';
import { registerStEnv } from './src/st-env.js';
import { EXTENSION_DISPLAY_NAME, loadSettings } from './src/storage.js';

// Register live getters so submodules stay decoupled from folder depth
registerStEnv({
    getContextFn: () => getContext(),
    extensionSettingsObj: extension_settings,
    getPresetManagerFn: (apiId = '') => getPresetManager(apiId),
    getWorldNamesFn: () => world_names || [],
    getSelectedWorldInfoFn: () => selected_world_info || [],
});

$(document).ready(function () {
    // Ensure settings & v1 -> v2 migration run cleanly on startup
    loadSettings();
    mountExtensionEntries();
    snapshotInitialPresets();

    const reportError = error => console.error(`[${EXTENSION_DISPLAY_NAME}] 聊天绑定应用失败`, error);
    const capture = createCaptureControls(() => promptManager, applyCurrentChatBinding);
    const applyChat = () => {
        capture.mount();
        capture.stopIfChanged();
        installPromptOverrides(promptManager);
        return applyCurrentChatBinding().catch(reportError);
    };
    const { eventSource, eventTypes } = getContext();
    if (eventTypes?.APP_READY) eventSource.on(eventTypes.APP_READY, () => {
        mountExtensionEntries();
        return applyChat();
    });
    if (eventTypes?.CHAT_CHANGED) eventSource.on(eventTypes.CHAT_CHANGED, () => {
        mountExtensionEntries();
        return applyChat();
    });
    if (eventTypes?.MAIN_API_CHANGED) eventSource.on(eventTypes.MAIN_API_CHANGED, applyChat);
    if (eventTypes?.OAI_PRESET_CHANGED_BEFORE) eventSource.on(eventTypes.OAI_PRESET_CHANGED_BEFORE, capture.stop);
    if (eventTypes?.CHARACTER_DELETED) eventSource.on(eventTypes.CHARACTER_DELETED, capture.stop);
    if (eventTypes?.OAI_PRESET_IMPORT_READY) eventSource.on(eventTypes.OAI_PRESET_IMPORT_READY, markPresetImportActivity);
    if (eventTypes?.CHARACTER_RENAMED) eventSource.on(eventTypes.CHARACTER_RENAMED, handleCharacterRenamed);
    if (eventTypes?.PRESET_RENAMED) eventSource.on(eventTypes.PRESET_RENAMED, handlePresetRenamed);

    // Track file-based preset imports across OpenAI, Text Completion & Master Import
    $(document).on(
        'change input',
        '#openai_preset_import_file, [data-preset-manager-file], #af_master_import_file',
        markPresetImportActivity,
    );

    // Core listener for preset switching across all SillyTavern APIs
    $(document).on('change', 'select[data-preset-manager-for]', handlePresetSelectChange);

    void applyChat();
});
