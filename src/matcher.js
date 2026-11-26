// Smart preset version / near-name update matcher

const BUILTIN_SKIP_PRESETS = new Set([
    'default',
    'gui',
    'none',
    'standard',
]);

// Leading bracketed metadata tags often added by preset authors, e.g. 【11.26更新】, [新版], (v2.0修复)
const LEADING_META_TAG_RE = /^(?:[\[【（(《「『]\s*(?:\d{1,4}[-./月]\d{1,2}|\d{6,8}|v?\d+(?:\.\d+)+|更新|新版|重置|修复|汉化|特供|先行|测试|正式|fix|beta|rc|update)[^\]】）)》」』]{0,12}[\]】）)》」』]\s*)+/i;

// Trailing copy suffixes added by OS / browser / ST, e.g. (1), （2）, - 副本, _copy
const TRAILING_COPY_RE = /(?:\s*[-_—]?\s*(?:副本|copy(?:\s*\d+)?)|\s*[(（\[]\s*\d{1,2}\s*[)）\]])+$/gi;

// Trailing stage/edition suffixes, e.g. 正式版, 测试版, 修复版, beta2, rc1, hotfix, sp
const TRAILING_STAGE_RE = /[\s\-_—·.|/]*(?:alpha|beta|rc|fix|hotfix|patch|ver|final|release|test|wip|sp|先行版?|测试版?|正式版?|修复版?|更新版?|重置版?|精简版?|完整版?|定稿版?|最终版?|新版)\d*$/i;

// Trailing explicit or numeric version / date suffixes, e.g. v1.2.3, V2, _1.05, 20261126, 11.26, 0925
const TRAILING_VERSION_OR_DATE_RE = /(?:[\s\-_—·.|/]*(?:v|ver\.?)\s*\d+(?:\.\d+)*[a-z]?|[\s\-_—·.|/]+20\d{6}|[\s\-_—·.|/]+\d{4}[-./]\d{1,2}[-./]\d{1,2}|[\s\-_—·.|/]+\d+(?:\.\d+)+[a-z]?|[\s\-_—·.|/]+(?:0[1-9]|1[0-2])[.-][0-3]\d|[\s\-_—·.|/]+(?:0[1-9]|1[0-2])[0-3]\d)$/i;

// Bracketed version/stage suffix at the end, e.g. (v1.2), 【2.0正式版】, [fix2]
const TRAILING_BRACKET_VER_RE = /\s*[\[【（(]\s*(?:v?\d+(?:\.\d+)*[a-z]?|20\d{6}|(?:alpha|beta|rc|fix|hotfix|patch|sp|更新|新版|修复|测试|正式)[^\]】）)]{0,10})\s*[\]】）)]$/i;

// Inline explicit version markers like `v1.2` or `Ver 2.0` anywhere in the string
const INLINE_EXPLICIT_VER_RE = /(?:^|[\s\-_—·.|/])(?:v|ver\.?)\s*\d+(?:\.\d+)*[a-z]?(?=$|[\s\-_—·.|/\u4e00-\u9fa5])/gi;

/**
 * Extracts a normalized signature from a preset name so `主力预设 v1.1` and `主力预设 v1.2 (正式版)`
 * resolve to the same `coreKey`.
 * @param {string} rawName
 */
export function extractPresetSignature(rawName) {
    const original = String(rawName ?? '').trim();
    if (!original) {
        return { original: '', cleanBase: '', coreKey: '', hadVersionMarker: false };
    }

    let s = original.normalize('NFKC').trim();
    let before = s;

    s = s.replace(LEADING_META_TAG_RE, '').trim();
    s = s.replace(TRAILING_COPY_RE, '').trim();

    // Iteratively peel off trailing version, stage, and bracketed version markers
    for (let i = 0; i < 6; i++) {
        const prev = s;
        s = s.replace(TRAILING_BRACKET_VER_RE, '').trim();
        s = s.replace(TRAILING_STAGE_RE, '').trim();
        s = s.replace(TRAILING_VERSION_OR_DATE_RE, '').trim();
        s = s.replace(TRAILING_COPY_RE, '').trim();
        if (s === prev) break;
    }

    // Also strip explicit `v1.x` tokens that sat in the middle
    const afterInline = s.replace(INLINE_EXPLICIT_VER_RE, ' ').trim();
    if (afterInline.replace(/[\s\-_—·.|/]+/g, '').length >= 2) {
        s = afterInline;
    }

    // If stripping removed everything (e.g. preset literally named "v1.0"), fall back to original without copy suffix
    if (!s) {
        s = original.normalize('NFKC').replace(TRAILING_COPY_RE, '').trim();
    }

    const hadVersionMarker = s !== before;
    const coreKey = s
        .toLowerCase()
        .replace(/[\s\-_—·.,:;!?'"`|/\\+~*#@$%^&=<>\[\]【】()（）《》「」『』｛｝{}]+/g, '');

    return {
        original,
        cleanBase: s,
        coreKey,
        hadVersionMarker,
    };
}

/**
 * Computes Sørensen–Dice bigram similarity in [0, 1] between two normalized keys.
 */
function diceSimilarity(a, b) {
    if (!a || !b) return 0;
    if (a === b) return 1;
    if (a.length < 2 || b.length < 2) return 0;

    const counts = new Map();
    for (let i = 0; i < a.length - 1; i++) {
        const bg = a.slice(i, i + 2);
        counts.set(bg, (counts.get(bg) || 0) + 1);
    }

    let intersection = 0;
    for (let i = 0; i < b.length - 1; i++) {
        const bg = b.slice(i, i + 2);
        const c = counts.get(bg) || 0;
        if (c > 0) {
            counts.set(bg, c - 1);
            intersection++;
        }
    }

    return (2 * intersection) / ((a.length - 1) + (b.length - 1));
}

/**
 * Checks if an unbound `candidateName` looks like an updated version or near-name variant
 * of any preset already bound in `bindingGroups`.
 *
 * @param {string} candidateName
 * @param {Array<{ id: string, name?: string, presets: string[], lorebooks: string[], updatedAt?: number }>} bindingGroups
 * @returns {{ group: object, matchedPreset: string, score: number, exactBase: boolean } | null}
 */
export function findPresetUpdateMatch(candidateName, bindingGroups) {
    const name = String(candidateName || '').trim();
    if (!name || BUILTIN_SKIP_PRESETS.has(name.toLowerCase())) {
        return null;
    }
    if (!Array.isArray(bindingGroups) || bindingGroups.length === 0) {
        return null;
    }

    // Never match if candidate is already explicitly bound
    for (const grp of bindingGroups) {
        if (grp.presets?.includes(name)) {
            return null;
        }
    }

    const candSig = extractPresetSignature(name);
    if (candSig.coreKey.length < 2) {
        return null;
    }

    let best = null;

    for (const grp of bindingGroups) {
        if (!Array.isArray(grp.presets) || !grp.lorebooks?.length) continue;

        for (const boundPreset of grp.presets) {
            if (!boundPreset || BUILTIN_SKIP_PRESETS.has(boundPreset.toLowerCase())) continue;
            const boundSig = extractPresetSignature(boundPreset);
            if (boundSig.coreKey.length < 2) continue;

            let score = 0;
            let exactBase = false;

            if (candSig.coreKey === boundSig.coreKey) {
                score = 1.0;
                exactBase = true;
            } else if (candSig.coreKey.length >= 3 && boundSig.coreKey.length >= 3) {
                const shorter = candSig.coreKey.length <= boundSig.coreKey.length ? candSig.coreKey : boundSig.coreKey;
                const longer = candSig.coreKey.length <= boundSig.coreKey.length ? boundSig.coreKey : candSig.coreKey;
                const lengthRatio = shorter.length / longer.length;
                const dice = diceSimilarity(candSig.coreKey, boundSig.coreKey);

                if ((longer.startsWith(shorter) || longer.includes(shorter)) && shorter.length >= 3 && lengthRatio >= 0.6) {
                    score = Math.max(dice, 0.82 + lengthRatio * 0.12);
                } else if (dice >= 0.82 && (candSig.hadVersionMarker || boundSig.hadVersionMarker)) {
                    score = dice;
                }
            }

            if (score >= 0.82) {
                const isBetter = !best
                    || score > best.score + 0.001
                    || (Math.abs(score - best.score) <= 0.001 && (grp.updatedAt || 0) > (best.group.updatedAt || 0));

                if (isBetter) {
                    best = {
                        group: grp,
                        matchedPreset: boundPreset,
                        score,
                        exactBase,
                    };
                }
            }
        }
    }

    return best;
}

/**
 * Scans all available presets and returns unbound candidates that match existing binding groups.
 */
export function scanAllUnboundPresetUpdates(allPresets, bindingGroups, ignoredPresets = []) {
    const ignored = new Set(Array.isArray(ignoredPresets) ? ignoredPresets : []);
    const results = [];

    for (const preset of Array.isArray(allPresets) ? allPresets : []) {
        if (!preset || ignored.has(preset)) continue;
        const match = findPresetUpdateMatch(preset, bindingGroups);
        if (match) {
            results.push({
                candidatePreset: preset,
                ...match,
            });
        }
    }

    return results;
}
