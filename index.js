// Global Lorebook Keeper for Entity - v1.2
// Original author: sleepyfish
// Enhanced with multi-preset binding groups, smart preset update inheritance & modernized UI

import { extension_settings, getContext } from '../../../extensions.js';
import { getPresetManager } from '../../../preset-manager.js';
import { selected_world_info, world_names } from '../../../world-info.js';

import {
    applyCharacterPreset,
    handleCharacterRenamed,
    handlePresetRenamed,
    handlePresetSelectChange,
    markPresetImportActivity,
    snapshotInitialPresets,
} from './src/core.js';
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

    // Retry mounting in case async extension containers render slightly later
    setTimeout(mountExtensionEntries, 1200);
    setTimeout(mountExtensionEntries, 3000);

    const ctx = getContext();
    const { eventSource, eventTypes } = ctx;

    if (eventSource && eventTypes) {
        if (eventTypes.CHAT_CHANGED) {
            eventSource.on(eventTypes.CHAT_CHANGED, () => {
                mountExtensionEntries();
                applyCharacterPreset();
            });
        }

        if (eventTypes.OAI_PRESET_IMPORT_READY) {
            eventSource.on(eventTypes.OAI_PRESET_IMPORT_READY, () => {
                markPresetImportActivity();
            });
        }

        if (eventTypes.PRESET_RENAMED) {
            eventSource.on(eventTypes.PRESET_RENAMED, (payload) => {
                handlePresetRenamed(payload);
            });
        }

        if (eventTypes.CHARACTER_RENAMED) {
            eventSource.on(eventTypes.CHARACTER_RENAMED, (oldAvatar, newAvatar) => {
                handleCharacterRenamed(oldAvatar, newAvatar);
            });
        }
    }

    // Track file-based preset imports across OpenAI, Text Completion & Master Import
    $(document).on(
        'change input',
        '#openai_preset_import_file, [data-preset-manager-file], #af_master_import_file',
        markPresetImportActivity,
    );

    // Core listener for preset switching across all SillyTavern APIs
    $(document).on('change', 'select[data-preset-manager-for]', handlePresetSelectChange);

    console.log(`[${EXTENSION_DISPLAY_NAME}] v1.2 loaded.`);
});
