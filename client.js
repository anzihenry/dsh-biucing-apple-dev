/**
 * Apple Dev — Client half.
 *
 * Renders one settings page plus its navigation icon and nothing else. All
 * data comes from the Host half's two loopback JSON routes (`lib/ui.js`):
 *
 *   GET  /dsh-biucing-apple-dev/status  -> toolchain, signing, simulators, xcodeMcp
 *   POST /dsh-biucing-apple-dev/action  -> { action, device } -> simulators
 *
 * A Host without those routes (the bundle's Host half not installed/enabled)
 * answers 404 or a non-JSON app shell: the page then shows an installation
 * explanation instead of blanking or crashing the slot.
 *
 * This file is the Client bundle artifact format — a `window.__ModuleLoader__`
 * load whose factory equals the package name, with the whole module body
 * inside the factory so script execution only registers the factory. It is
 * authored directly as plain JavaScript: no build step, no package imports
 * beyond the shell-provided `react` seed, no global DOM side effects.
 */
window.__ModuleLoader__.load({
  id: 'dsh-biucing-apple-dev',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useCallback, useEffect, useRef, useState } = React;

    /* ------------------------------------------------------------------ *
     * Identity and Host contract
     * ------------------------------------------------------------------ */
    const LOCALE_NS = 'biucing-apple-dev';
    const SECTION_ID = 'biucing-apple-dev';
    const STATUS_ENDPOINT = '/dsh-biucing-apple-dev/status';
    const ACTION_ENDPOINT = '/dsh-biucing-apple-dev/action';
    /** Platform groups render in this order; anything else sorts last. */
    const PLATFORM_ORDER = ['iOS', 'tvOS', 'watchOS', 'visionOS'];
    const SDK_PREVIEW = 4;
    const IDENTITY_PREVIEW = 3;
    const XCODE_PREVIEW = 2;

    /* ------------------------------------------------------------------ *
     * Locale dictionaries (registered with the host locale service)
     * ------------------------------------------------------------------ */
    const STRINGS = {
      en: {
        'section.title': 'Apple Dev',
        'section.subtitle': 'Xcode toolchain, Xcode MCP and simulators',
        'refresh': 'Refresh',
        'refreshing': 'Refreshing…',
        'lastUpdated': 'Last refreshed',
        'never': 'Never',
        'loading': 'Reading the Xcode toolchain…',
        'value.unknown': 'Unknown',
        'value.none': 'None',
        'count.installed': '{count} installed',
        'count.more': '+{count} more',
        'platform.unknown': 'Other',
        'state.booted': 'Booted',
        'state.shutdown': 'Shutdown',
        'state.unknown': 'Unknown',
        'toolchain.title': 'Toolchain',
        'toolchain.xcode': 'Xcode',
        'toolchain.build': 'build',
        'toolchain.path': 'xcodebuild path',
        'toolchain.developerDir': 'Active developer directory',
        'toolchain.platform': 'macOS platform',
        'toolchain.swift': 'Swift',
        'toolchain.sdks': 'SDKs',
        'toolchain.signing': 'Signing identities',
        'toolchain.signingCount': '{count} available',
        'toolchain.runtimes': 'Simulator runtimes',
        'toolchain.xcodes': 'Installed Xcodes',
        'toolchain.warnings': 'Warnings',
        'mcp.title': 'Xcode MCP',
        'mcp.server': 'Server',
        'mcp.toolsLabel': 'Tools',
        'mcp.toolCount': '{count} tools',
        'mcp.approvalLabel': 'Agent approval',
        'mcp.bridgeLabel': 'Bridge',
        'mcp.state.ready': 'Connected',
        'mcp.state.connecting': 'Connecting…',
        'mcp.state.unavailable': 'Not connected',
        'mcp.state.disabled': 'Disabled',
        'mcp.state.unknown': 'Unknown',
        'mcp.approval.granted': 'Granted',
        'mcp.approval.pending': 'Pending',
        'mcp.approval.unknown': 'Not checked',
        'mcp.readyHint': 'The agent can call build, test, preview, device-interaction, console-log and debugger tools.',
        'mcp.connectingHint': 'Starting xcrun mcpbridge and reading its tool catalog.',
        'mcp.unavailableHint': 'Start Xcode 26 or later, then refresh. The bridge process is xcrun mcpbridge.',
        'mcp.disabledHint': 'Set mcpEnabled: true in the plugin configuration to expose Xcode MCP tools.',
        'mcp.reconnect': 'Reconnect',
        'mcp.reconnecting': 'Reconnecting…',
        'mcp.openWorkspace': 'Open workspace',
        'mcp.opening': 'Opening…',
        'mcp.openPlaceholder': '/path/to/App.xcodeproj',
        'mcp.actionDone': 'Done.',
        'mcp.actionFailed': 'The MCP action failed.',
        'simulators.title': 'Simulators',
        'simulators.count': '{count} total',
        'simulators.empty': 'No simulators installed',
        'simulators.emptyHint': 'Create one in Xcode under Window → Devices and Simulators, then refresh.',
        'simulators.unavailable': 'Unavailable',
        'action.boot': 'Boot',
        'action.shutdown': 'Shutdown',
        'action.open': 'Open',
        'action.erase': 'Erase',
        'action.working': 'Working…',
        'action.eraseConfirm': 'Erase "{name}"? All of its data and installed apps will be deleted.',
        'action.done': 'Done.',
        'action.failed': 'The action failed.',
        'error.title': 'Could not load Apple Dev status',
        'error.missingTitle': 'Apple Dev Host half is not available',
        'error.missingBody': 'This page is the Client half. It needs the dsh-biucing-apple-dev bundle installed and enabled on the Host, which serves the status route and the simulator action route.',
        'error.missingHint': 'Install or enable the bundle on the Host, restart Harness, then refresh this page.',
        'error.hint': 'Check that the Harness Host is running, then retry.',
        'error.retry': 'Retry',
        'error.http': 'The Host answered with HTTP {status}.',
        'error.network': 'Could not reach the Harness Host.',
        'footer.note': 'Status and simulator actions travel over the loopback routes below; nothing leaves this machine.',
      },
      zh: {
        'section.title': 'Apple 开发',
        'section.subtitle': 'Xcode 工具链、Xcode MCP 与模拟器',
        'refresh': '刷新',
        'refreshing': '正在刷新…',
        'lastUpdated': '最近刷新',
        'never': '尚未刷新',
        'loading': '正在读取 Xcode 工具链…',
        'value.unknown': '未知',
        'value.none': '无',
        'count.installed': '{count} 个',
        'count.more': '另有 {count} 个',
        'platform.unknown': '其他',
        'state.booted': '已启动',
        'state.shutdown': '已关机',
        'state.unknown': '未知',
        'toolchain.title': '工具链',
        'toolchain.xcode': 'Xcode',
        'toolchain.build': '构建',
        'toolchain.path': 'xcodebuild 路径',
        'toolchain.developerDir': '当前开发者目录',
        'toolchain.platform': 'macOS 平台',
        'toolchain.swift': 'Swift',
        'toolchain.sdks': 'SDK',
        'toolchain.signing': '签名身份',
        'toolchain.signingCount': '{count} 个可用',
        'toolchain.runtimes': '模拟器运行时',
        'toolchain.xcodes': '已安装的 Xcode',
        'toolchain.warnings': '警告',
        'mcp.title': 'Xcode MCP',
        'mcp.server': '服务器',
        'mcp.toolsLabel': '工具',
        'mcp.toolCount': '{count} 个',
        'mcp.approvalLabel': 'Agent 审批',
        'mcp.bridgeLabel': '桥接',
        'mcp.state.ready': '已连接',
        'mcp.state.connecting': '连接中…',
        'mcp.state.unavailable': '未连接',
        'mcp.state.disabled': '已禁用',
        'mcp.state.unknown': '未知',
        'mcp.approval.granted': '已批准',
        'mcp.approval.pending': '待批准',
        'mcp.approval.unknown': '尚未检查',
        'mcp.readyHint': 'Agent 可调用构建、测试、Preview、模拟器交互、控制台日志与调试器命令。',
        'mcp.connectingHint': '正在启动 xcrun mcpbridge 并读取工具目录。',
        'mcp.unavailableHint': '请启动 Xcode 26 或更新版本后刷新；桥接进程为 xcrun mcpbridge。',
        'mcp.disabledHint': '在插件配置中设置 mcpEnabled: true 后即可暴露 Xcode MCP 工具。',
        'mcp.reconnect': '重新连接',
        'mcp.reconnecting': '正在重连…',
        'mcp.openWorkspace': '打开工程',
        'mcp.opening': '正在打开…',
        'mcp.openPlaceholder': '/path/to/App.xcodeproj',
        'mcp.actionDone': '已完成。',
        'mcp.actionFailed': 'MCP 操作失败。',
        'simulators.title': '模拟器',
        'simulators.count': '共 {count} 个',
        'simulators.empty': '没有安装模拟器',
        'simulators.emptyHint': '在 Xcode 的「窗口 → 设备和模拟器」中创建一个，然后刷新。',
        'simulators.unavailable': '不可用',
        'action.boot': '启动',
        'action.shutdown': '关机',
        'action.open': '打开',
        'action.erase': '抹掉',
        'action.working': '处理中…',
        'action.eraseConfirm': '抹掉「{name}」？其所有数据和已安装应用都会被删除。',
        'action.done': '已完成。',
        'action.failed': '操作失败。',
        'error.title': '无法加载 Apple 开发状态',
        'error.missingTitle': 'Apple 开发 Host 部分不可用',
        'error.missingBody': '此页面是 Client 部分。需要在 Host 上安装并启用 dsh-biucing-apple-dev bundle，由它提供状态路由与模拟器操作路由。',
        'error.missingHint': '在 Host 上安装或启用该 bundle，重启 Harness，然后刷新此页面。',
        'error.hint': '请确认 Harness Host 正在运行，然后重试。',
        'error.retry': '重试',
        'error.http': 'Host 返回了 HTTP {status}。',
        'error.network': '无法连接到 Harness Host。',
        'footer.note': '状态与模拟器操作通过下方的本机回环路由传输，不会离开这台机器。',
      },
    };

    /**
     * Last-resort translation when the locale service is unavailable.
     * @param {string} key dictionary key.
     * @returns {string} English text, or the key itself.
     */
    function fallbackTranslate(key) {
      const dict = STRINGS.en;
      return dict && dict[key] !== undefined ? dict[key] : key;
    }

    /**
     * Replace `{name}` placeholders in one already-translated template.
     * @param {string} template localized text.
     * @param {object} values placeholder values.
     * @returns {string} filled text.
     */
    function format(template, values) {
      const source = String(template === undefined || template === null ? '' : template);
      return source.replace(/\{(\w+)\}/g, (match, name) => (
        values && values[name] !== undefined ? String(values[name]) : match
      ));
    }

    /**
     * Format one timestamp in the browser locale, falling back to the raw value.
     * @param {Date|string|number} value timestamp to render.
     * @returns {string} display text.
     */
    function formatTimestamp(value) {
      let date = value instanceof Date ? value : new Date(value);
      if (Number.isNaN(date.getTime())) return String(value);
      try {
        return date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
      } catch (error) {
        return date.toISOString();
      }
    }

    /**
     * Human-readable text for an unexpected thrown value.
     * @param {unknown} error thrown value.
     * @returns {string} message text.
     */
    function errorText(error) {
      if (error && typeof error.message === 'string') return error.message;
      return String(error === undefined ? 'unknown error' : error);
    }

    /* ------------------------------------------------------------------ *
     * Styles: host theme tokens only, scoped by the `biucing-adp-` prefix
     * ------------------------------------------------------------------ */
    const STYLE_TEXT = [
      '.biucing-adp-root,.biucing-adp-root *,.biucing-adp-root *::before,.biucing-adp-root *::after{box-sizing:border-box;}',
      '.biucing-adp-root{display:flex;flex-direction:column;gap:16px;max-width:760px;color:var(--dsw-alias-label-primary);font-family:inherit;line-height:1.5;}',
      '.biucing-adp-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;flex-wrap:wrap;}',
      '.biucing-adp-head-main{display:flex;align-items:center;gap:12px;min-width:0;}',
      '.biucing-adp-mark{display:inline-flex;align-items:center;justify-content:center;width:38px;height:38px;flex:none;}',
      '.biucing-adp-head-text{display:flex;flex-direction:column;gap:2px;min-width:0;}',
      '.biucing-adp-title{margin:0;font-size:20px;line-height:28px;font-weight:600;color:var(--dsw-alias-label-primary);}',
      '.biucing-adp-subtitle{margin:0;font-size:13px;line-height:18px;color:var(--dsw-alias-label-tertiary);}',
      '.biucing-adp-head-actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}',
      '.biucing-adp-updated{font-size:12px;line-height:18px;color:var(--dsw-alias-label-caption,var(--dsw-alias-label-secondary));',
      'font-variant-numeric:tabular-nums;white-space:nowrap;}',
      '.biucing-adp-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:32px;padding:0 13px;border-radius:16px;',
      'border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);',
      'font:inherit;font-size:13px;line-height:18px;cursor:pointer;transition:background .12s ease;}',
      '.biucing-adp-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-solid,var(--dsw-alias-bg-layer-2));}',
      '.biucing-adp-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px;}',
      '.biucing-adp-btn:disabled{opacity:.4;cursor:default;}',
      '.biucing-adp-btn-primary{border-color:transparent;background:var(--dsw-alias-button-primary-fill,var(--dsw-alias-brand-primary));',
      'color:var(--dsw-alias-label-primary-foreground,var(--dsw-alias-label-primary-inverted));}',
      '.biucing-adp-btn-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover,var(--dsw-alias-brand-primary));filter:brightness(1.04);}',
      '.biucing-adp-btn-sm{height:28px;padding:0 11px;border-radius:14px;font-size:12px;line-height:18px;gap:5px;}',
      '.biucing-adp-btn-danger{color:var(--dsw-alias-state-error-primary);}',
      '.biucing-adp-btn-danger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger,var(--dsw-alias-bg-layer-2));}',
      '.biucing-adp-card{display:flex;flex-direction:column;gap:12px;padding:16px;border-radius:12px;',
      'border:1px solid var(--dsw-alias-settings-card-stroke,var(--dsw-alias-border-l2));',
      'background:var(--dsw-alias-settings-card-fill,var(--dsw-alias-bg-layer-1));}',
      '.biucing-adp-card-head{display:flex;align-items:baseline;justify-content:space-between;gap:12px;flex-wrap:wrap;}',
      '.biucing-adp-card-title{margin:0;font-size:14px;line-height:22px;font-weight:600;color:var(--dsw-alias-label-primary);}',
      '.biucing-adp-card-meta{font-size:12px;line-height:18px;color:var(--dsw-alias-label-caption,var(--dsw-alias-label-secondary));',
      '.biucing-adp-card-hint{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);}',
      '.biucing-adp-mcp-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding-top:10px;border-top:1px solid var(--dsw-alias-border-l1);}',
      '.biucing-adp-input{flex:1 1 200px;min-width:0;height:28px;padding:0 11px;border-radius:14px;border:1px solid var(--dsw-alias-border-l2);',
      'background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:18px;}',
      '.biucing-adp-input::placeholder{color:var(--dsw-alias-label-tertiary);}',
      '.biucing-adp-input:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px;}',
      '.biucing-adp-input:disabled{opacity:.5;}',
      'font-variant-numeric:tabular-nums;}',
      '.biucing-adp-fields{display:flex;flex-direction:column;gap:0;margin:0;}',
      '.biucing-adp-field{display:grid;grid-template-columns:minmax(132px,.85fr) minmax(0,1.6fr);gap:4px 16px;align-items:start;',
      'padding:7px 0;border-top:1px solid var(--dsw-alias-border-l1);}',
      '.biucing-adp-field:first-child{border-top:0;}',
      '.biucing-adp-field-label{margin:0;font-size:12.5px;line-height:20px;color:var(--dsw-alias-label-tertiary);}',
      '.biucing-adp-field-value{margin:0;display:flex;align-items:center;gap:6px;flex-wrap:wrap;min-width:0;',
      'font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere;}',
      '.biucing-adp-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;}',
      '.biucing-adp-tag{display:inline-flex;align-items:center;font-size:11px;line-height:16px;padding:0 6px;border-radius:5px;',
      'border:1px solid var(--dsw-alias-border-l3);color:var(--dsw-alias-label-secondary);white-space:nowrap;}',
      '.biucing-adp-chips{display:flex;flex-wrap:wrap;gap:5px;min-width:0;}',
      '.biucing-adp-chip{display:inline-flex;align-items:center;max-width:100%;padding:1px 7px;border-radius:6px;',
      'border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);',
      'font-size:11.5px;line-height:17px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
      '.biucing-adp-warnings{display:flex;flex-direction:column;gap:6px;padding-top:10px;border-top:1px solid var(--dsw-alias-border-l1);',
      'color:var(--dsw-alias-state-warn-label,var(--dsw-alias-state-warn-primary));}',
      '.biucing-adp-warnings-head{display:flex;align-items:center;gap:6px;font-size:12px;font-weight:600;line-height:18px;}',
      '.biucing-adp-warning-list{margin:0;padding-left:18px;display:flex;flex-direction:column;gap:3px;',
      'font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);}',
      '.biucing-adp-notice{display:flex;align-items:flex-start;gap:8px;padding:9px 12px;border-radius:10px;',
      'border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);',
      'font-size:12.5px;line-height:19px;color:var(--dsw-alias-label-secondary);}',
      '.biucing-adp-notice-error{color:var(--dsw-alias-state-error-primary);}',
      '.biucing-adp-notice-success{color:var(--dsw-alias-state-success-primary);}',
      '.biucing-adp-group{display:flex;flex-direction:column;gap:2px;padding:10px 12px;border-radius:10px;',
      'border:1px solid var(--dsw-alias-border-l1);}',
      '.biucing-adp-group-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:2px 0 4px;}',
      '.biucing-adp-group-title{font-size:12px;line-height:18px;letter-spacing:.04em;text-transform:uppercase;',
      'font-weight:600;color:var(--dsw-alias-label-secondary);}',
      '.biucing-adp-group-count{font-size:11px;line-height:16px;color:var(--dsw-alias-label-caption,var(--dsw-alias-label-secondary));',
      'font-variant-numeric:tabular-nums;}',
      '.biucing-adp-devices{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;}',
      '.biucing-adp-device{display:flex;align-items:center;gap:12px;padding:9px 0;border-top:1px solid var(--dsw-alias-border-l1);}',
      '.biucing-adp-device:first-child{border-top:0;}',
      '.biucing-adp-device-id{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1 1 auto;}',
      '.biucing-adp-device-name-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0;}',
      '.biucing-adp-device-name{font-size:13.5px;line-height:20px;font-weight:500;color:var(--dsw-alias-label-primary);',
      'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.biucing-adp-device-meta{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:12px;line-height:18px;',
      'color:var(--dsw-alias-label-tertiary);}',
      '.biucing-adp-udid{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;line-height:16px;',
      'color:var(--dsw-alias-label-caption,var(--dsw-alias-label-secondary));}',
      '.biucing-adp-device-actions{display:flex;align-items:center;gap:6px;flex-wrap:wrap;flex:none;}',
      '.biucing-adp-device-unavailable .biucing-adp-device-name{color:var(--dsw-alias-label-tertiary);}',
      '.biucing-adp-badge{display:inline-flex;align-items:center;gap:5px;flex:none;padding:0 7px;height:19px;border-radius:999px;',
      'border:1px solid var(--dsw-alias-border-l3);font-size:11px;line-height:17px;color:var(--dsw-alias-label-secondary);white-space:nowrap;}',
      '.biucing-adp-badge-dot{width:5px;height:5px;border-radius:50%;background:currentColor;flex:none;}',
      '.biucing-adp-badge-booted{color:var(--dsw-alias-state-success-primary);border-color:currentColor;}',
      '.biucing-adp-badge-other{color:var(--dsw-alias-state-warn-primary);border-color:currentColor;}',
      '.biucing-adp-badge-shutdown{color:var(--dsw-alias-label-secondary);}',
      '.biucing-adp-empty{display:flex;flex-direction:column;align-items:center;gap:6px;padding:24px 16px;border-radius:10px;',
      'border:1px dashed var(--dsw-alias-border-l2);text-align:center;color:var(--dsw-alias-label-secondary);}',
      '.biucing-adp-empty-title{margin:0;font-size:13px;line-height:20px;font-weight:500;color:var(--dsw-alias-label-primary);}',
      '.biucing-adp-empty-hint{margin:0;max-width:46ch;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);}',
      '.biucing-adp-loading{display:flex;flex-direction:column;gap:12px;}',
      '.biucing-adp-loading-head{display:flex;align-items:center;gap:8px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary);}',
      '.biucing-adp-skeletons{display:flex;flex-direction:column;gap:8px;}',
      '.biucing-adp-skeleton{display:block;height:10px;border-radius:5px;background:var(--dsw-alias-bg-skeleton,var(--dsw-alias-bg-layer-2));',
      'animation:biucing-adp-pulse 1.2s ease-in-out infinite;}',
      '.biucing-adp-skeleton:nth-child(2){width:72%;}',
      '.biucing-adp-skeleton:nth-child(3){width:88%;}',
      '.biucing-adp-spinner{width:14px;height:14px;flex:none;border-radius:50%;border:2px solid var(--dsw-alias-border-l2);',
      'border-top-color:var(--dsw-alias-brand-primary);animation:biucing-adp-spin .8s linear infinite;}',
      '.biucing-adp-error{align-items:flex-start;}',
      '.biucing-adp-error-title{margin:0;font-size:14px;line-height:22px;font-weight:600;color:var(--dsw-alias-label-primary);}',
      '.biucing-adp-error-body{margin:0;font-size:12.5px;line-height:19px;color:var(--dsw-alias-label-secondary);}',
      '.biucing-adp-error-hint{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);}',
      '.biucing-adp-error-actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding-top:2px;}',
      '.biucing-adp-endpoint{display:inline-flex;padding:1px 6px;border-radius:5px;border:1px solid var(--dsw-alias-border-l1);',
      'background:var(--dsw-alias-bg-layer-2);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;',
      'font-size:11.5px;color:var(--dsw-alias-label-secondary);}',
      '.biucing-adp-foot{display:flex;flex-direction:column;gap:4px;font-size:11.5px;line-height:17px;',
      'color:var(--dsw-alias-label-caption,var(--dsw-alias-label-secondary));}',
      '.biucing-adp-foot p{margin:0;}',
      '.biucing-adp-foot code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;',
      'color:var(--dsw-alias-label-tertiary);}',
      '@keyframes biucing-adp-spin{to{transform:rotate(360deg);}}',
      '@keyframes biucing-adp-pulse{0%,100%{opacity:.55;}50%{opacity:1;}}',
      '@media (prefers-reduced-motion: reduce){.biucing-adp-spinner,.biucing-adp-skeleton{animation:none;}}',
      '@media (max-width:620px){',
      '.biucing-adp-field{grid-template-columns:minmax(0,1fr);gap:2px;}',
      '.biucing-adp-device{flex-wrap:wrap;}',
      '.biucing-adp-device-actions{width:100%;justify-content:flex-end;}',
      '}',
    ].join('\n');

    /* ------------------------------------------------------------------ *
     * Host request helpers
     * ------------------------------------------------------------------ */
    /**
     * Fetch one JSON route without throwing: network, non-JSON, missing-route
     * and HTTP failure all become one discriminated result the page can render.
     * @param {string} url route to call.
     * @param {object} init fetch init.
     * @returns {Promise<object>} `{ kind, status?, body?, error? }`.
     */
    async function requestJson(url, init) {
      let response;
      try {
        response = await fetch(url, init);
      } catch (error) {
        return { kind: 'network', error };
      }
      let body;
      try {
        body = await response.json();
      } catch (error) {
        // No JSON answer: the route does not exist (a 404, or the web server's
        // non-JSON app-shell fallback), so the Host half is not installed.
        return { kind: 'missing', status: response.status };
      }
      if (body === null || typeof body !== 'object') {
        return { kind: 'not-json', status: response.status };
      }
      // A JSON 404 body is a route ANSWER (unknown device, refused action),
      // not a missing route: only a non-JSON answer above means no Host half.
      return {
        kind: response.ok ? 'ok' : 'http',
        status: response.status,
        body,
      };
    }

    /**
     * Localized explanation for a status-route failure.
     * @param {object} result requestJson result.
     * @param {Function} t translate function.
     * @returns {string} message text.
     */
    function describeFailure(result, t) {
      if (!result) return t('error.title');
      if (result.kind === 'http') return format(t('error.http'), { status: result.status });
      if (result.kind === 'network') return t('error.network');
      return t('error.title');
    }

    /* ------------------------------------------------------------------ *
     * Data shaping helpers
     * ------------------------------------------------------------------ */
    /**
     * Sort simulators into platform groups, known platforms first.
     * @param {Array} simulators status-payload simulator rows.
     * @returns {Array<{platform: string, devices: Array}>} ordered groups.
     */
    function groupSimulators(simulators) {
      const rows = Array.isArray(simulators) ? simulators : [];
      const groups = new Map();
      for (const device of rows) {
        if (!device || typeof device !== 'object') continue;
        const platform = typeof device.platform === 'string' && device.platform.length > 0
          ? device.platform
          : 'unknown';
        if (!groups.has(platform)) groups.set(platform, []);
        groups.get(platform).push(device);
      }
      const orderOf = (platform) => {
        const index = PLATFORM_ORDER.indexOf(platform);
        return index === -1 ? PLATFORM_ORDER.length : index;
      };
      return Array.from(groups.entries())
        .sort((left, right) => orderOf(left[0]) - orderOf(right[0]) || left[0].localeCompare(right[0]))
        .map(([platform, devices]) => ({
          platform,
          devices: devices.slice().sort((left, right) => (
            String(left.name || '').localeCompare(String(right.name || ''))
            || String(left.osVersion || '').localeCompare(String(right.osVersion || ''))
          )),
        }));
    }

    /**
     * Classify a simctl device state for badge styling.
     * @param {unknown} state raw state text.
     * @returns {'booted'|'shutdown'|'other'} badge kind.
     */
    function stateKind(state) {
      const value = String(state === undefined || state === null ? '' : state).toLowerCase();
      if (value === 'booted') return 'booted';
      if (value === 'shutdown') return 'shutdown';
      return 'other';
    }

    /**
     * Platform display name; unknown platforms get the localized "Other".
     * @param {unknown} platform raw platform text.
     * @param {Function} t translate function.
     * @returns {string} display text.
     */
    function platformName(platform, t) {
      const value = typeof platform === 'string' ? platform : '';
      if (value.length === 0 || value === 'unknown') return t('platform.unknown');
      return value;
    }

    /**
     * Shorten a UDID for the row meta line; the full value stays in the title.
     * @param {unknown} udid device identifier.
     * @returns {string} short display text.
     */
    function shortUdid(udid) {
      const value = String(udid === undefined || udid === null ? '' : udid);
      return value.length > 10 ? value.slice(0, 8) + '…' : value;
    }

    /**
     * Join the first few names of a list as one display string.
     * @param {Array} items source rows.
     * @param {Function} labelOf row to text.
     * @param {number} limit preview length.
     * @param {Function} t translate function.
     * @returns {string|null} preview text, or null when nothing remains.
     */
    function preview(items, labelOf, limit, t) {
      const rows = Array.isArray(items) ? items : [];
      const names = rows.slice(0, limit).map(labelOf).filter((name) => name.length > 0);
      if (names.length === 0) return null;
      const rest = rows.length - names.length;
      const text = names.join(', ');
      return rest > 0 ? text + ' ' + format(t('count.more'), { count: rest }) : text;
    }

    /* ------------------------------------------------------------------ *
     * Presentational pieces
     * ------------------------------------------------------------------ */
    /**
     * Xcode-inspired bundle mark: a blueprint-blue tile with a subtle grid and
     * a dark claw hammer. An original glyph in the spirit of Xcode's icon —
     * Apple's own artwork is not reproduced.
     * @param {object} props `{ size, active }` owner props plus optional size.
     * @returns {object} SVG element.
     */
    function XcodeMark(props) {
      const size = Number(props && props.size) || 18;
      const active = Boolean(props && props.active);
      const rawId = typeof React.useId === 'function' ? React.useId() : 'mark';
      const uid = String(rawId).replace(/[^a-zA-Z0-9_-]/g, '') || 'mark';
      const id = (name) => 'adp-xc-' + uid + '-' + name;
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 128 128',
        'aria-hidden': true,
        focusable: false,
        style: { display: 'block', opacity: active ? 1 : 0.94 },
      },
      h('defs', null,
        h('linearGradient', { id: id('bg'), x1: 0, y1: 0, x2: 0, y2: 1 },
          h('stop', { offset: 0, stopColor: '#1FA2FF' }),
          h('stop', { offset: 1, stopColor: '#0A63DC' })),
        h('linearGradient', { id: id('steel'), x1: 0, y1: 0, x2: 0, y2: 1 },
          h('stop', { offset: 0, stopColor: '#454B53' }),
          h('stop', { offset: 0.5, stopColor: '#262A30' }),
          h('stop', { offset: 1, stopColor: '#121519' })),
        h('linearGradient', { id: id('grip'), x1: 0, y1: 0, x2: 0, y2: 1 },
          h('stop', { offset: 0, stopColor: '#33383F' }),
          h('stop', { offset: 1, stopColor: '#0D1013' })),
        h('clipPath', { id: id('clip') },
          h('rect', { x: 6, y: 6, width: 116, height: 116, rx: 26 })),
        h('mask', { id: id('mask'), maskUnits: 'userSpaceOnUse', x: 0, y: 0, width: 128, height: 128 },
          h('rect', { x: 32, y: 33, width: 66, height: 16, rx: 7, fill: '#fff' }),
          h('rect', { x: 59.5, y: 47, width: 11, height: 62, rx: 5.5, fill: '#fff' }),
          h('path', { d: 'M32 38 L52 47 L32 55 Z', fill: '#000' }),
          h('path', { d: 'M32 41 L44 47 L32 50 Z', fill: '#fff' }))),
      h('rect', { x: 6, y: 6, width: 116, height: 116, rx: 26, fill: 'url(#' + id('bg') + ')' }),
      h('g', { clipPath: 'url(#' + id('clip') + ')' },
        h('g', { stroke: '#FFFFFF', strokeOpacity: 0.11, strokeWidth: 1.2 },
          h('path', { d: 'M34 6V122M64 6V122M94 6V122' }),
          h('path', { d: 'M6 34H122M6 64H122M6 94H122' })),
        h('g', { transform: 'rotate(45 64 64)' },
          h('g', { mask: 'url(#' + id('mask') + ')' },
            h('rect', { x: 32, y: 33, width: 66, height: 16, rx: 7, fill: 'url(#' + id('steel') + ')' }),
            h('rect', { x: 59.5, y: 47, width: 11, height: 62, rx: 5.5, fill: 'url(#' + id('grip') + ')' }),
            h('rect', { x: 59.5, y: 92, width: 11, height: 17, rx: 5.5, fill: '#0A0D11' })),
          h('path', { d: 'M36 36 H88', stroke: '#8A929D', strokeOpacity: 0.5, strokeWidth: 1.4, strokeLinecap: 'round' }))),
      h('rect', {
        x: 6.8, y: 6.8, width: 114.4, height: 114.4, rx: 25.4,
        fill: 'none', stroke: '#FFFFFF', strokeOpacity: 0.2, strokeWidth: 1.6,
      }));
    }

    /**
     * Small inline glyph set used by states, notices and the refresh button.
     * @param {object} props `{ name, size }`.
     * @returns {object} SVG element.
     */
    function Glyph(props) {
      const name = props && props.name;
      const size = Number(props && props.size) || 14;
      const stroke = {
        stroke: 'currentColor',
        strokeWidth: 1.7,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
      };
      let shape;
      if (name === 'refresh') {
        shape = h(React.Fragment, null,
          h('path', Object.assign({ d: 'M19.4 11.2a7.6 7.6 0 11-2.2-5' }, stroke)),
          h('path', Object.assign({ d: 'M17.2 2.8v3.8h-3.8' }, stroke)));
      } else if (name === 'warn') {
        shape = h(React.Fragment, null,
          h('path', Object.assign({ d: 'M12 4.2l8.4 14.6H3.6L12 4.2z' }, stroke)),
          h('path', Object.assign({ d: 'M12 9.6v3.6M12 16.2v.1' }, stroke)));
      } else if (name === 'error') {
        shape = h(React.Fragment, null,
          h('circle', Object.assign({ cx: 12, cy: 12, r: 8.4 }, stroke)),
          h('path', Object.assign({ d: 'M12 7.8v5M12 15.8v.1' }, stroke)));
      } else if (name === 'check') {
        shape = h('path', Object.assign({ d: 'M5 12.8l4.2 4.2L19 7.2' }, stroke));
      } else if (name === 'sim') {
        shape = h(React.Fragment, null,
          h('rect', Object.assign({ x: 6.6, y: 3.4, width: 10.8, height: 17.2, rx: 2.4 }, stroke)),
          h('path', Object.assign({ d: 'M10.4 17.6h3.2' }, stroke)));
      } else {
        shape = h('circle', Object.assign({ cx: 12, cy: 12, r: 7 }, stroke));
      }
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none',
        'aria-hidden': true,
        focusable: false,
        style: { display: 'block', flex: 'none' },
      }, shape);
    }

    /**
     * Device state badge: Booted / Shutdown / the raw simulator state.
     * @param {object} props `{ state, t }`.
     * @returns {object} span element.
     */
    function StateBadge(props) {
      const t = props.t;
      const kind = stateKind(props.state);
      const raw = props.state === undefined || props.state === null ? '' : String(props.state);
      let label;
      if (kind === 'booted') label = t('state.booted');
      else if (kind === 'shutdown') label = t('state.shutdown');
      else label = raw.length > 0 ? raw : t('state.unknown');
      return h('span', { className: 'biucing-adp-badge biucing-adp-badge-' + kind },
        h('span', { className: 'biucing-adp-badge-dot', 'aria-hidden': true }),
        h('span', null, label));
    }

    /**
     * One simulator row with its state badge and the four allowed actions.
     * @param {object} props `{ device, t, busy, onAction }`.
     * @returns {object} row element.
     */
    function DeviceRow(props) {
      const t = props.t;
      const device = props.device || {};
      const busy = props.busy || null;
      const busyKey = busy ? busy.udid : null;
      const deviceKey = String(device.udid || device.name || '');
      const rowBusyAction = busyKey !== null && busyKey === deviceKey ? busy.action : null;
      const anyBusy = Boolean(busy);
      const booted = stateKind(device.state) === 'booted';
      const unavailable = device.isAvailable === false;
      const name = String(device.name || device.udid || t('value.unknown'));
      const version = device.osVersion ? String(device.osVersion) : '';
      const meta = [
        version ? (platformName(device.platform, t) + ' ' + version) : platformName(device.platform, t),
      ];
      const actions = ['boot', 'shutdown', 'open', 'erase'];
      const buttons = actions.map((action) => {
        const working = rowBusyAction === action;
        const disabled = anyBusy
          || unavailable
          || (action === 'boot' && booted)
          || (action === 'shutdown' && !booted);
        return h('button', {
          key: action,
          type: 'button',
          className: 'biucing-adp-btn biucing-adp-btn-sm'
            + (action === 'erase' ? ' biucing-adp-btn-danger' : ''),
          disabled,
          title: t('action.' + action),
          'aria-label': t('action.' + action) + ': ' + name,
          onClick: () => { props.onAction(device, action); },
        },
        working ? h('span', { className: 'biucing-adp-spinner', 'aria-hidden': true }) : null,
        h('span', null, working ? t('action.working') : t('action.' + action)));
      });
      return h('div', { className: 'biucing-adp-device' + (unavailable ? ' biucing-adp-device-unavailable' : '') },
        h('div', { className: 'biucing-adp-device-id' },
          h('div', { className: 'biucing-adp-device-name-row' },
            h('span', { className: 'biucing-adp-device-name', title: name }, name),
            h(StateBadge, { state: device.state, t: t }),
            unavailable ? h('span', { className: 'biucing-adp-tag' }, t('simulators.unavailable')) : null),
          h('div', { className: 'biucing-adp-device-meta' },
            meta.map((text, index) => h('span', { key: 'meta-' + index }, text)),
            device.udid ? h('code', { className: 'biucing-adp-udid', title: String(device.udid) }, shortUdid(device.udid)) : null)),
        h('div', { className: 'biucing-adp-device-actions' }, buttons));
    }

    /**
     * Warning list (toolchain warnings from the Host report).
     * @param {object} props `{ warnings, t }`.
     * @returns {object|null} warning block, or null when there is nothing to show.
     */
    function WarningList(props) {
      const warnings = Array.isArray(props.warnings) ? props.warnings : [];
      if (warnings.length === 0) return null;
      return h('div', { className: 'biucing-adp-warnings', role: 'status' },
        h('div', { className: 'biucing-adp-warnings-head' },
          h(Glyph, { name: 'warn', size: 14 }),
          h('span', null, props.t('toolchain.warnings'))),
        h('ul', { className: 'biucing-adp-warning-list' },
          warnings.map((warning, index) => h('li', { key: 'warning-' + index }, String(warning)))));
    }

    /**
     * Inline notice for action results and Host-reported problems.
     * @param {object} props `{ tone, text }`.
     * @returns {object} notice element.
     */
    function Notice(props) {
      const tone = props.tone === 'error' ? 'error' : props.tone === 'success' ? 'success' : 'info';
      return h('div', {
        className: 'biucing-adp-notice biucing-adp-notice-' + tone,
        role: tone === 'error' ? 'alert' : 'status',
      },
      h(Glyph, { name: tone === 'success' ? 'check' : tone === 'error' ? 'error' : 'warn', size: 14 }),
      h('span', null, String(props.text === undefined || props.text === null ? '' : props.text)));
    }

    /**
     * Toolchain card: Xcode/build/path, developer directory, platform, SDKs,
     * signing identities, runtimes, installed Xcodes, and Host warnings.
     * @param {object} props `{ snapshot, t }`.
     * @returns {object} card element.
     */
    function ToolchainCard(props) {
      const t = props.t;
      const snapshot = props.snapshot || {};
      const toolchain = snapshot.toolchain && typeof snapshot.toolchain === 'object' ? snapshot.toolchain : {};
      const signing = snapshot.signing && typeof snapshot.signing === 'object' ? snapshot.signing : {};
      const xcodebuild = toolchain.xcodebuild && typeof toolchain.xcodebuild === 'object' ? toolchain.xcodebuild : {};
      const sdks = Array.isArray(toolchain.sdks) ? toolchain.sdks : [];
      const runtimes = Array.isArray(toolchain.runtimes) ? toolchain.runtimes : [];
      const xcodes = Array.isArray(toolchain.xcodes) ? toolchain.xcodes : [];
      const identities = Array.isArray(signing.identities) ? signing.identities : [];
      const signingCount = typeof signing.count === 'number' ? signing.count : identities.length;
      const warnings = Array.isArray(toolchain.warnings) ? toolchain.warnings : [];
      const version = xcodebuild.version ? String(xcodebuild.version) : '';
      const build = xcodebuild.build ? String(xcodebuild.build) : '';
      const sdkNames = sdks.map((sdk) => String((sdk && (sdk.label || sdk.name || sdk.sdk)) || ''));
      const identityNames = identities.map((identity) => String((identity && identity.name) || ''));
      const xcodeNames = xcodes.map((xcode) => String((xcode && xcode.name) || ''));
      const runtimeNames = runtimes.map((runtime) => String((runtime && runtime.name) || ''));
      // Preview strings are computed once: a null preview means nothing to list.
      const runtimePreview = preview(runtimeNames, (name) => name, 2, t);
      const xcodePreview = preview(xcodeNames, (name) => name, XCODE_PREVIEW, t);

      const rows = [
        {
          key: 'xcode',
          label: t('toolchain.xcode'),
          value: version
            ? h(React.Fragment, null,
              h('span', null, version),
              build ? h('span', { className: 'biucing-adp-tag' }, t('toolchain.build') + ' ' + build) : null)
            : h('span', null, t('value.unknown')),
        },
        {
          key: 'path',
          label: t('toolchain.path'),
          mono: true,
          value: xcodebuild.path ? String(xcodebuild.path) : t('value.unknown'),
        },
        {
          key: 'developerDir',
          label: t('toolchain.developerDir'),
          mono: true,
          value: toolchain.developerDir ? String(toolchain.developerDir) : t('value.unknown'),
        },
        {
          key: 'platform',
          label: t('toolchain.platform'),
          value: snapshot.platform ? String(snapshot.platform) : t('value.unknown'),
        },
        {
          key: 'sdks',
          label: t('toolchain.sdks'),
          value: sdks.length === 0
            ? t('value.none')
            : h(React.Fragment, null,
              h('span', null, format(t('count.installed'), { count: sdks.length })),
              h('span', { className: 'biucing-adp-chips' },
                sdkNames.slice(0, SDK_PREVIEW).map((label, index) => h('span', {
                  key: 'sdk-' + index,
                  className: 'biucing-adp-chip',
                  title: label,
                }, label)),
                sdkNames.length > SDK_PREVIEW
                  ? h('span', { className: 'biucing-adp-chip' }, format(t('count.more'), { count: sdkNames.length - SDK_PREVIEW }))
                  : null)),
        },
        {
          key: 'signing',
          label: t('toolchain.signing'),
          value: h(React.Fragment, null,
            h('span', null, format(t('toolchain.signingCount'), { count: signingCount })),
            identityNames.length > 0
              ? h('span', { className: 'biucing-adp-chips' },
                identityNames.slice(0, IDENTITY_PREVIEW).map((label, index) => h('span', {
                  key: 'identity-' + index,
                  className: 'biucing-adp-chip',
                  title: label,
                }, label)),
                identityNames.length > IDENTITY_PREVIEW
                  ? h('span', { className: 'biucing-adp-chip' }, format(t('count.more'), { count: identityNames.length - IDENTITY_PREVIEW }))
                  : null)
              : null),
        },
      ];
      if (toolchain.swift) {
        rows.push({ key: 'swift', label: t('toolchain.swift'), value: String(toolchain.swift) });
      }
      rows.push({
        key: 'runtimes',
        label: t('toolchain.runtimes'),
        value: runtimes.length === 0
          ? t('value.none')
          : format(t('count.installed'), { count: runtimes.length })
            + (runtimePreview ? ' · ' + runtimePreview : ''),
      });
      if (xcodes.length > 0) {
        rows.push({
          key: 'xcodes',
          label: t('toolchain.xcodes'),
          value: format(t('count.installed'), { count: xcodes.length })
            + (xcodePreview ? ' · ' + xcodePreview : ''),
        });
      }

      return h('div', { className: 'biucing-adp-card' },
        h('div', { className: 'biucing-adp-card-head' },
          h('h3', { className: 'biucing-adp-card-title' }, t('toolchain.title'))),
        h('dl', { className: 'biucing-adp-fields' },
          rows.map((row) => h('div', { key: row.key, className: 'biucing-adp-field' },
            h('dt', { className: 'biucing-adp-field-label' }, row.label),
            h('dd', { className: 'biucing-adp-field-value' + (row.mono ? ' biucing-adp-mono' : '') }, row.value)))),
        h(WarningList, { warnings: warnings, t: t }));
    }

    /**
     * Simulators card: platforms as groups, one row per device, plus empty state.
     * @param {object} props `{ simulators, t, busy, onAction }`.
     * @returns {object} card element.
     */
    function SimulatorsCard(props) {
      const t = props.t;
      const simulators = Array.isArray(props.simulators) ? props.simulators : [];
      const groups = groupSimulators(simulators);
      return h('div', { className: 'biucing-adp-card' },
        h('div', { className: 'biucing-adp-card-head' },
          h('h3', { className: 'biucing-adp-card-title' }, t('simulators.title')),
          h('span', { className: 'biucing-adp-card-meta' }, format(t('simulators.count'), { count: simulators.length }))),
        groups.length === 0
          ? h('div', { className: 'biucing-adp-empty' },
            h(Glyph, { name: 'sim', size: 22 }),
            h('p', { className: 'biucing-adp-empty-title' }, t('simulators.empty')),
            h('p', { className: 'biucing-adp-empty-hint' }, t('simulators.emptyHint')))
          : groups.map((group) => h('div', { key: 'group-' + group.platform, className: 'biucing-adp-group' },
            h('div', { className: 'biucing-adp-group-head' },
              h('span', { className: 'biucing-adp-group-title' }, platformName(group.platform, t)),
              h('span', { className: 'biucing-adp-group-count' }, String(group.devices.length))),
            h('div', { className: 'biucing-adp-devices' },
              group.devices.map((device, index) => h(DeviceRow, {
                key: 'device-' + (device.udid || index),
                device: device,
                t: t,
                busy: props.busy,
                onAction: props.onAction,
              }))))));
    }

    /**
     * Xcode MCP card: bridge state, server identity, tool count and the
     * one-time agent approval Xcode grants per project folder.
     * @param {object} props `{ mcp, t }`.
     * @returns {object} card element.
     */
    function McpCard(props) {
      const t = props.t;
      const [workspacePath, setWorkspacePath] = useState('');
      const busy = typeof props.busy === 'string' ? props.busy : null;
      const notice = props.notice && typeof props.notice === 'object' ? props.notice : null;
      const info = props.mcp && typeof props.mcp === 'object' ? props.mcp : {};
      const state = typeof info.state === 'string' ? info.state : 'unknown';
      const server = info.server && typeof info.server === 'object' ? info.server : {};
      const toolCount = typeof info.toolCount === 'number' ? info.toolCount : null;
      const approval = typeof info.approval === 'string' ? info.approval : 'unknown';
      const bridge = typeof info.bridge === 'string' && info.bridge.length > 0 ? info.bridge : '';
      const knownStates = ['ready', 'connecting', 'unavailable', 'disabled'];
      const stateLabel = t('mcp.state.' + (knownStates.indexOf(state) === -1 ? 'unknown' : state));
      const badgeKind = state === 'ready' ? 'booted' : state === 'unavailable' ? 'other' : 'shutdown';
      const approvalLabel = approval === 'granted'
        ? t('mcp.approval.granted')
        : approval === 'pending' ? t('mcp.approval.pending') : t('mcp.approval.unknown');
      const hintKey = state === 'ready' ? 'mcp.readyHint'
        : state === 'connecting' ? 'mcp.connectingHint'
          : state === 'disabled' ? 'mcp.disabledHint' : 'mcp.unavailableHint';
      const serverLabel = server.name
        ? String(server.name) + (server.version ? ' ' + server.version : '')
        : t('value.unknown');
      const disabled = state === 'disabled';
      const canOpen = !disabled && !busy && workspacePath.trim().length > 0;
      const rows = [
        { key: 'server', label: t('mcp.server'), value: serverLabel },
        {
          key: 'tools',
          label: t('mcp.toolsLabel'),
          value: toolCount === null ? t('value.unknown') : format(t('mcp.toolCount'), { count: toolCount }),
        },
        { key: 'approval', label: t('mcp.approvalLabel'), value: approvalLabel },
        { key: 'bridge', label: t('mcp.bridgeLabel'), value: bridge || t('value.unknown'), mono: true },
      ];
      return h('div', { className: 'biucing-adp-card' },
        h('div', { className: 'biucing-adp-card-head' },
          h('h3', { className: 'biucing-adp-card-title' }, t('mcp.title')),
          h('span', { className: 'biucing-adp-badge biucing-adp-badge-' + badgeKind },
            h('span', { className: 'biucing-adp-badge-dot', 'aria-hidden': true }),
            h('span', null, stateLabel))),
        h('dl', { className: 'biucing-adp-fields' },
          rows.map((row) => h('div', { key: row.key, className: 'biucing-adp-field' },
            h('dt', { className: 'biucing-adp-field-label' }, row.label),
            h('dd', { className: 'biucing-adp-field-value' + (row.mono ? ' biucing-adp-mono' : '') }, row.value)))),
        info.error ? h(Notice, { tone: 'error', text: String(info.error) }) : null,
        h('div', { className: 'biucing-adp-mcp-actions' },
          h('input', {
            className: 'biucing-adp-input',
            type: 'text',
            value: workspacePath,
            placeholder: t('mcp.openPlaceholder'),
            'aria-label': t('mcp.openPlaceholder'),
            disabled: disabled || Boolean(busy),
            onChange: (event) => setWorkspacePath(event && event.target ? event.target.value : ''),
            onKeyDown: (event) => {
              if (event && event.key === 'Enter' && canOpen) props.onOpenWorkspace(workspacePath);
            },
          }),
          h('button', {
            type: 'button',
            className: 'biucing-adp-btn biucing-adp-btn-sm',
            disabled: !canOpen,
            onClick: () => props.onOpenWorkspace(workspacePath),
          },
          busy === 'mcp_open_workspace' ? h('span', { className: 'biucing-adp-spinner', 'aria-hidden': true }) : null,
          h('span', null, busy === 'mcp_open_workspace' ? t('mcp.opening') : t('mcp.openWorkspace'))),
          h('button', {
            type: 'button',
            className: 'biucing-adp-btn biucing-adp-btn-sm',
            disabled: disabled || Boolean(busy),
            onClick: () => props.onReconnect(),
          },
          busy === 'mcp_reconnect' ? h('span', { className: 'biucing-adp-spinner', 'aria-hidden': true }) : null,
          h('span', null, busy === 'mcp_reconnect' ? t('mcp.reconnecting') : t('mcp.reconnect')))),
        notice ? h(Notice, { tone: notice.tone, text: notice.text }) : null,
        h('p', { className: 'biucing-adp-card-hint' }, t(hintKey)));
    }

    /**
     * Loading state: one quiet card with a spinner and skeleton lines.
     * @param {object} props `{ t }`.
     * @returns {object} card element.
     */
    function LoadingCard(props) {
      return h('div', {
        className: 'biucing-adp-card biucing-adp-loading',
        role: 'status',
        'aria-live': 'polite',
      },
      h('div', { className: 'biucing-adp-loading-head' },
        h('span', { className: 'biucing-adp-spinner', 'aria-hidden': true }),
        h('span', null, props.t('loading'))),
      h('div', { className: 'biucing-adp-skeletons' },
        h('span', { className: 'biucing-adp-skeleton' }),
        h('span', { className: 'biucing-adp-skeleton' }),
        h('span', { className: 'biucing-adp-skeleton' })));
    }

    /**
     * Error state: a missing Host half explains the install requirement; any
     * other failure shows the HTTP/network detail. Both offer a retry.
     * @param {object} props `{ kind, detail, t, onRetry }`.
     * @returns {object} card element.
     */
    function ErrorState(props) {
      const t = props.t;
      const missing = props.kind === 'missing';
      const body = missing ? t('error.missingBody') : (props.detail || t('error.title'));
      const hint = missing ? t('error.missingHint') : t('error.hint');
      return h('div', { className: 'biucing-adp-card biucing-adp-error', role: 'alert' },
        h(Glyph, { name: 'error', size: 20 }),
        h('h3', { className: 'biucing-adp-error-title' }, missing ? t('error.missingTitle') : t('error.title')),
        h('p', { className: 'biucing-adp-error-body' }, body),
        h('p', { className: 'biucing-adp-error-hint' }, hint),
        h('div', { className: 'biucing-adp-error-actions' },
          h('button', {
            type: 'button',
            className: 'biucing-adp-btn biucing-adp-btn-primary',
            onClick: props.onRetry,
          },
          h(Glyph, { name: 'refresh', size: 14 }),
          h('span', null, t('error.retry'))),
          missing ? h('code', { className: 'biucing-adp-endpoint' }, STATUS_ENDPOINT) : null));
    }

    /* ------------------------------------------------------------------ *
     * The settings page
     * ------------------------------------------------------------------ */
    /**
     * The "Apple Dev" settings section component.
     *
     * Receives the shell's owner props (`close`) plus the standard slot props
     * when this registration declared a locale namespace; every other prop is
     * tolerated and ignored, and all state is local to the mounted page.
     *
     * @param {object} props slot-delivered props.
     * @returns {object} the page element tree.
     */
    function Page(props) {
      const owner = props && typeof props === 'object' ? props : {};
      const t = typeof owner.t === 'function' ? owner.t : fallbackTranslate;
      const close = typeof owner.close === 'function' ? owner.close : null;

      const [phase, setPhase] = useState('loading');
      const [snapshot, setSnapshot] = useState(null);
      const [failure, setFailure] = useState(null);
      const [fetchedAt, setFetchedAt] = useState(null);
      const [refreshing, setRefreshing] = useState(false);
      const [notice, setNotice] = useState(null);
      const [busy, setBusy] = useState(null);
      const [mcpBusy, setMcpBusy] = useState(null);
      const [mcpNotice, setMcpNotice] = useState(null);

      const aliveRef = useRef(true);
      const seqRef = useRef(0);
      const mcpPollRef = useRef(0);
      const tRef = useRef(t);
      tRef.current = t;

      /**
       * Read the Host status route. The route is only touched from the mounted
       * page (never at module load) and only the newest answer is applied.
       * @param {boolean} manual whether this is a user-triggered refresh.
       * @returns {Promise<void>} settles after the state update.
       */
      const fetchStatus = useCallback(async (manual) => {
        if (!aliveRef.current) return;
        const seq = ++seqRef.current;
        if (manual) setRefreshing(true);
        try {
          const result = await requestJson(manual ? STATUS_ENDPOINT + '?refresh=1' : STATUS_ENDPOINT, {
            headers: { accept: 'application/json' },
            cache: 'no-store',
          });
          if (!aliveRef.current || seq !== seqRef.current) return;
          if (result.kind === 'missing' || result.kind === 'not-json') {
            setFailure({ kind: 'missing' });
            setPhase('missing');
            return;
          }
          if (result.kind !== 'ok') {
            setFailure({ kind: result.kind === 'http' ? 'http' : 'network', status: result.status });
            setPhase('error');
            return;
          }
          setSnapshot(result.body);
          setFetchedAt(new Date());
          setFailure(null);
          setPhase('ready');
        } catch (error) {
          if (!aliveRef.current || seq !== seqRef.current) return;
          setFailure({ kind: 'network', message: errorText(error) });
          setPhase('error');
        } finally {
          if (aliveRef.current && seq === seqRef.current) setRefreshing(false);
        }
      }, []);

      useEffect(() => {
        aliveRef.current = true;
        void fetchStatus(false);
        return () => {
          aliveRef.current = false;
          seqRef.current += 1;
        };
      }, [fetchStatus]);

      // The MCP bridge starts lazily on the Host, so the first status answer can
      // be "connecting". Poll a few times until the probe settles.
      useEffect(() => {
        const info = snapshot && snapshot.xcodeMcp;
        if (phase !== 'ready' || !info || info.state !== 'connecting') {
          mcpPollRef.current = 0;
          return undefined;
        }
        if (mcpPollRef.current >= 8) return undefined;
        mcpPollRef.current += 1;
        const timer = setTimeout(() => { void fetchStatus(false); }, 1500);
        return () => clearTimeout(timer);
      }, [phase, snapshot, fetchStatus]);

      const refresh = useCallback(() => {
        setNotice(null);
        setMcpNotice(null);
        void fetchStatus(true);
      }, [fetchStatus]);

      /**
       * POST one simulator action, confirming destructive erases first, then
       * fold the returned simulator list (or a status re-read) into the page.
       * @param {object} device simulator row the shell supplied.
       * @param {string} action one of boot/shutdown/open/erase.
       * @returns {Promise<void>} settles after the row leaves its busy state.
       */
      const runAction = async (device, action) => {
        if (busy) return;
        if (!device || typeof device !== 'object') return;
        const name = String(device.name || device.udid || '');
        if (action === 'erase') {
          let confirmed = false;
          try {
            confirmed = typeof window !== 'undefined' && typeof window.confirm === 'function'
              ? window.confirm(format(tRef.current('action.eraseConfirm'), { name }))
              : true;
          } catch (error) {
            confirmed = false;
          }
          if (!confirmed) return;
        }
        const selector = String(device.udid || device.name || '');
        if (selector.length === 0) return;
        setNotice(null);
        setBusy({ udid: String(device.udid || selector), action: action });
        try {
          const result = await requestJson(ACTION_ENDPOINT, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action: action, device: selector }),
          });
          if (!aliveRef.current) return;
          if (result.kind === 'missing' || result.kind === 'not-json') {
            setNotice({
              tone: 'error',
              text: tRef.current('error.missingTitle') + ' ' + tRef.current('error.missingBody'),
            });
            return;
          }
          const body = result.body && typeof result.body === 'object' ? result.body : {};
          if (Array.isArray(body.simulators)) {
            setSnapshot((previous) => (previous
              ? Object.assign({}, previous, { simulators: body.simulators })
              : previous));
            setFetchedAt(new Date());
          } else if (result.kind === 'ok') {
            void fetchStatus(false);
          }
          if (!aliveRef.current) return;
          if (result.kind === 'ok' && body.ok !== false) {
            setNotice({
              tone: 'success',
              text: body.message ? String(body.message) : tRef.current('action.done'),
            });
            // Opening Simulator.app leaves the settings dialog behind by
            // design; the shell's `close` owner prop is exactly that exit.
            if (action === 'open' && close) close();
          } else {
            const message = body.error
              ? String(body.error)
              : body.message
                ? String(body.message)
                : tRef.current('action.failed') + ' ' + describeFailure(result, tRef.current);
            setNotice({ tone: 'error', text: message });
          }
        } catch (error) {
          if (aliveRef.current) {
            setNotice({
              tone: 'error',
              text: tRef.current('action.failed') + ' ' + errorText(error),
            });
          }
        } finally {
          if (aliveRef.current) setBusy(null);
        }
      };

      /**
       * POST one Xcode MCP action (reconnect or open workspace) and fold the
       * outcome into a card-local notice; the status refetch then repaints the
       * badge and tool count.
       * @param {string} action mcp_reconnect or mcp_open_workspace.
       * @param {object} [payload] extra body fields (path).
       * @returns {Promise<void>} settles after the notice update.
       */
      const runMcpAction = async (action, payload) => {
        if (mcpBusy) return;
        setMcpNotice(null);
        setMcpBusy(action);
        try {
          const result = await requestJson(ACTION_ENDPOINT, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(Object.assign({ action: action }, payload || {})),
          });
          if (!aliveRef.current) return;
          if (result.kind === 'missing' || result.kind === 'not-json') {
            setMcpNotice({ tone: 'error', text: tRef.current('error.missingTitle') });
            return;
          }
          const body = result.body && typeof result.body === 'object' ? result.body : {};
          if (result.kind === 'ok' && body.ok !== false) {
            setMcpNotice({ tone: 'success', text: body.message ? String(body.message) : tRef.current('mcp.actionDone') });
            void fetchStatus(false);
          } else {
            setMcpNotice({ tone: 'error', text: body.error ? String(body.error) : tRef.current('mcp.actionFailed') });
          }
        } catch (error) {
          if (aliveRef.current) setMcpNotice({ tone: 'error', text: tRef.current('mcp.actionFailed') + ' ' + errorText(error) });
        } finally {
          if (aliveRef.current) setMcpBusy(null);
        }
      };

      const ready = phase === 'ready' && snapshot !== null;
      const updatedLabel = fetchedAt ? formatTimestamp(fetchedAt) : t('never');
      const loadingNow = phase === 'loading' || refreshing;
      const simulators = snapshot && Array.isArray(snapshot.simulators) ? snapshot.simulators : [];
      const reportError = snapshot && snapshot.error ? String(snapshot.error) : null;

      return h(React.Fragment, null,
        h('style', null, STYLE_TEXT),
        h('section', { className: 'biucing-adp-root', 'aria-label': t('section.title') },
          h('header', { className: 'biucing-adp-head' },
            h('div', { className: 'biucing-adp-head-main' },
              h('span', { className: 'biucing-adp-mark' }, h(XcodeMark, { size: 34 })),
              h('div', { className: 'biucing-adp-head-text' },
                h('h2', { className: 'biucing-adp-title' }, t('section.title')),
                h('p', { className: 'biucing-adp-subtitle' }, t('section.subtitle')))),
            h('div', { className: 'biucing-adp-head-actions' },
              h('span', { className: 'biucing-adp-updated' }, t('lastUpdated') + ': ' + updatedLabel),
              h('button', {
                type: 'button',
                className: 'biucing-adp-btn',
                disabled: loadingNow || Boolean(busy),
                onClick: refresh,
              },
              loadingNow
                ? h('span', { className: 'biucing-adp-spinner', 'aria-hidden': true })
                : h(Glyph, { name: 'refresh', size: 14 }),
              h('span', null, loadingNow ? t('refreshing') : t('refresh'))))),

          notice ? h(Notice, { tone: notice.tone, text: notice.text }) : null,

          phase === 'loading' ? h(LoadingCard, { t: t }) : null,
          phase === 'missing' ? h(ErrorState, { kind: 'missing', t: t, onRetry: refresh }) : null,
          phase === 'error'
            ? h(ErrorState, {
              kind: 'error',
              detail: describeFailure(failure, t),
              t: t,
              onRetry: refresh,
            })
            : null,

          ready
            ? h(React.Fragment, null,
              reportError ? h(Notice, { tone: 'error', text: reportError }) : null,
              h(ToolchainCard, { snapshot: snapshot, t: t }),
              snapshot.xcodeMcp ? h(McpCard, {
                mcp: snapshot.xcodeMcp,
                t: t,
                busy: mcpBusy,
                notice: mcpNotice,
                onReconnect: () => { void runMcpAction('mcp_reconnect'); },
                onOpenWorkspace: (path) => { void runMcpAction('mcp_open_workspace', { path: path }); },
              }) : null,
              h(SimulatorsCard, {
                simulators: simulators,
                t: t,
                busy: busy,
                onAction: runAction,
              }))
            : null,

          h('footer', { className: 'biucing-adp-foot' },
            h('p', null, t('footer.note')),
            h('p', null,
              h('code', null, STATUS_ENDPOINT),
              h('span', null, ' · '),
              h('code', null, ACTION_ENDPOINT)))));
    }

    /**
     * Navigation icon component for the "Apple Dev" section entry.
     * Receives the shell's `{ size, active }` owner props.
     * @param {object} props owner props.
     * @returns {object} mark element.
     */
    function SectionIcon(props) {
      return h(XcodeMark, {
        size: Number(props && props.size) || 16,
        active: Boolean(props && props.active),
      });
    }

    /* ------------------------------------------------------------------ *
     * Plugin definition
     * ------------------------------------------------------------------ */
    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        let t = fallbackTranslate;
        try {
          ctx.effect(() => {
            const disposers = [];
            [['en', STRINGS.en], ['zh', STRINGS.zh]].forEach((pair) => {
              try {
                disposers.push(ctx.locale.register(LOCALE_NS, pair[0], pair[1]));
              } catch (error) {
                /* A host that rejects one dictionary still renders the other. */
              }
            });
            return () => {
              disposers.forEach((dispose) => {
                try {
                  dispose();
                } catch (error) {
                  /* already disposed */
                }
              });
            };
          }, 'biucing-apple-dev: dictionaries');
          if (typeof ctx.locale.bind === 'function') t = ctx.locale.bind(LOCALE_NS);
        } catch (error) {
          /* A host without the locale service still renders English. */
          t = fallbackTranslate;
        }

        /**
         * Register one slot entry; the inject wrapper makes the registration
         * wait for (and re-run with) the owning slot declaration. A host that
         * does not declare a slot just never runs the callback — never a throw.
         * @param {string} name slot key.
         * @param {Function} component slot component.
         * @param {object} options registration options.
         * @returns {void}
         */
        const register = (name, component, options) => {
          try {
            ctx.slots.inject(name, () => ctx.slots.register(Object.assign({ name: name }, options), component));
          } catch (error) {
            try {
              console.warn('[dsh-biucing-apple-dev] could not register ' + name, error);
            } catch (ignored) {
              /* no console in this host */
            }
          }
        };

        register('settings.section', Page, {
          id: SECTION_ID,
          order: 22,
          label: () => t('section.title'),
          locale: LOCALE_NS,
        });
        register('settings.section.icon', SectionIcon, {
          id: SECTION_ID,
          order: 22,
          label: () => t('section.title'),
        });
      },
    };
  },
});
