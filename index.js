// NewFace 世界书新角色 —— SillyTavern UI 扩展入口

import { open } from './src/ui.js';

const WAND_ID = 'nf-wand-button';

function addWandButton() {
    if (document.getElementById(WAND_ID)) return;
    const menu = document.getElementById('extensionsMenu');
    if (!menu) return;
    const item = document.createElement('div');
    item.id = WAND_ID;
    item.className = 'list-group-item flex-container flexGap5 interactable';
    item.tabIndex = 0;
    item.innerHTML = '<div class="fa-solid fa-user-plus extensionsMenuExtensionButton"></div><span>世界书新角色</span>';
    item.addEventListener('click', () => open());
    menu.appendChild(item);
}

function addSettingsPanel() {
    const host = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
    if (!host || document.getElementById('nf-settings-panel')) return;
    const wrap = document.createElement('div');
    wrap.id = 'nf-settings-panel';
    wrap.innerHTML = `
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>NewFace 世界书新角色</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <div>根据当前角色卡绑定的世界书生成全新角色的 SFW / NSFW 资料，不会拿世界书里已有的人物充数。</div>
                <div class="menu_button" id="nf-open-btn">打开</div>
            </div>
        </div>`;
    wrap.querySelector('#nf-open-btn').addEventListener('click', () => open());
    host.appendChild(wrap);
}

function registerSlash() {
    const c = globalThis.SillyTavern?.getContext?.();
    try {
        c?.SlashCommandParser?.addCommandObject?.(c.SlashCommand.fromProps({
            name: 'newface',
            aliases: ['新角色'],
            helpString: '打开 NewFace：根据当前角色绑定的世界书生成全新角色资料',
            callback: async () => {
                await open();
                return '';
            },
        }));
    } catch (e) {
        console.warn('[NewFace] 注册斜杠命令失败', e);
    }
}

function init() {
    if (!globalThis.SillyTavern?.getContext) {
        console.error('[NewFace] 找不到 SillyTavern.getContext');
        return;
    }
    addWandButton();
    addSettingsPanel();
    registerSlash();
    console.log('[NewFace] 已加载');
}

if (globalThis.jQuery) globalThis.jQuery(init);
else if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
