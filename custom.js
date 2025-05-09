(async () => {
    'use strict';

    const config = {
        // デフォルト以外のワークスペースで自動タブスタックを使用する (true: 有効, false: 無効)
        // Use automatic tab stacking in non-default workspaces (true: enable, false: disable)
        workspace: false,

        // サブドメインごとにタブをスタックする (true: 有効, false: 無効)
        // Stack tabs by subdomain (true: enable, false: disable)
        subdomain: true,

        // タブスタック名を自動的に変更する (0: 無効, 1: ホスト名を使用, 2: ベースドメインから生成)
        // Automatically change tab stack names (0: disabled, 1: use hostname, 2: generated from base domain)
        stackname: 0,

        // 自動タブスタックの対象とするホストのルール (完全一致もしくは正規表現)
        // Rules for hosts to be included in the automatic tab stack (exact match or regular expression)
        includes: [],

        // 自動タブスタックから除外するホストのルール (完全一致もしくは正規表現)
        // Rules for hosts to be excluded from the automatic tab stack (exact match or regular expression)
        excludes: [
            // 'www.example.com',
            // /^(.+\.)?example\.net$/,
        ],
    };

    // Safety wrapper for parsing JSON with fallback
    const safeParseJSON = (jsonString) => {
        if (!jsonString) return {};
        try {
            return JSON.parse(jsonString);
        } catch (e) {
            console.warn('Failed to parse JSON:', e);
            return {};
        }
    };

    const addTabGroup = async (tabId, groupId) => {
        try {
            const tab = await chrome.tabs.get(tabId);
            // Safety check for vivExtData
            const extData = tab.vivExtData ? safeParseJSON(tab.vivExtData) : {};
            extData.group = groupId;
            await chrome.tabs.update(tabId, { vivExtData: JSON.stringify(extData) });
        } catch (e) {
            console.error('Error in addTabGroup:', e);
        }
    };

    const getUrlFragments = (url) => {
        try {
            return vivaldi.utilities.getUrlFragments(url);
        } catch (e) {
            console.error('Error in getUrlFragments:', e);
            // Fallback implementation if vivaldi.utilities.getUrlFragments is not available
            const urlObj = new URL(url);
            const hostParts = urlObj.hostname.split('.');
            const tld = hostParts.slice(-1)[0];
            return { host: urlObj.hostname, tld };
        }
    };

    const getBaseDomain = (url) => {
        try {
            const urlFragments = getUrlFragments(url);
            return urlFragments.host.match(`([^.]+\\.${ urlFragments.tld })$`)?.[1] || urlFragments.host;
        } catch (e) {
            console.error('Error in getBaseDomain:', e);
            return new URL(url).hostname;
        }
    };

    const getHostname = (url) => config.subdomain ? getUrlFragments(url).host : getBaseDomain(url);

    const matchHostRule = (url, rule) => {
        try {
            const hostname = getUrlFragments(url).host;
            return rule instanceof RegExp ? rule.test(hostname) : hostname === rule;
        } catch (e) {
            console.error('Error in matchHostRule:', e);
            return false;
        }
    };

    const getTabInfo = async (tabId) => {
        try {
            const tab = await chrome.tabs.get(tabId);

            if (tab.id !== -1) {
                // Safety check for vivExtData
                tab.vivExtData = tab.vivExtData ? safeParseJSON(tab.vivExtData) : {};
                return tab;
            }
        } catch (e) {
            console.error('Error in getTabInfo:', e);
            return null;
        }
    };

    const getTabStore = async () => {
        try {
            const tabStore = {};

            const tabs = (await chrome.tabs.query({ currentWindow: true }))
                .filter(tab => tab.id !== -1)
                .map(tab => {
                    // Safety check for vivExtData
                    tab.vivExtData = tab.vivExtData ? safeParseJSON(tab.vivExtData) : {};
                    return tab;
                })
                .filter(tab => !tab.pinned)
                .filter(tab => tab.vivExtData && !tab.vivExtData.panelId)
                .filter(tab => !config.includes.length ? true : config.includes.find(rule => matchHostRule(tab.url, rule)))
                .filter(tab => !config.excludes.find(rule => matchHostRule(tab.url, rule)));

            // Object.groupBy polyfill for older browsers
            const groupBy = (array, keyFn) => {
                return array.reduce((result, item) => {
                    const key = keyFn(item);
                    (result[key] = result[key] || []).push(item);
                    return result;
                }, {});
            };

            const workspaces = groupBy(tabs, (tab) => tab.vivExtData.workspaceId || 'undefined');

            for (const [workspaceId, workspaceTabs] of Object.entries(workspaces)) {
                tabStore[workspaceId] = groupBy(workspaceTabs, (tab) => tab.vivExtData.group || 'undefined');
            }
            return tabStore;
        } catch (e) {
            console.error('Error in getTabStore:', e);
            return {};
        }
    };

    const getTabGroupMap = (tabStore) => {
        try {
            const tabGroupMap = {};

            for (const [workspaceId, groups] of Object.entries(tabStore)) {
                tabGroupMap[workspaceId] = {};

                for (const [groupId, tabs] of Object.entries(groups)) {
                    // Object.groupBy polyfill for older browsers
                    const groupBy = (array, keyFn) => {
                        return array.reduce((result, item) => {
                            const key = keyFn(item);
                            (result[key] = result[key] || []).push(item);
                            return result;
                        }, {});
                    };

                    const hostnameGroups = groupBy(tabs, (tab) => getHostname(tab.url));
                    const hostnames = Object.keys(hostnameGroups);

                    if (hostnames.length === 1 && groupId && groupId !== 'undefined') {
                        tabGroupMap[workspaceId][hostnames[0]] ??= [];
                        tabGroupMap[workspaceId][hostnames[0]].push(groupId);
                    }
                }
            }
            return tabGroupMap;
        } catch (e) {
            console.error('Error in getTabGroupMap:', e);
            return {};
        }
    };

    const groupingTabs = async (targetTab) => {
        try {
            if (!targetTab || !targetTab.url) return;
            
            const tabStore = await getTabStore();
            const tabGroupMap = getTabGroupMap(tabStore);

            for (const [workspaceId, groups] of Object.entries(tabStore)) {
                if (!config.workspace && workspaceId !== 'undefined') continue;
                if (!targetTab.vivExtData) continue;
                if (String(targetTab.vivExtData.workspaceId || 'undefined') !== workspaceId) continue;

                const tabGroups = {};
                for (const tabs of Object.values(groups)) {
                    for (const tab of tabs) {
                        const hostname = getHostname(tab.url);
                        tabGroupMap[workspaceId][hostname] ??= [crypto.randomUUID()];

                        const groupId = tabGroupMap[workspaceId][hostname].sort()[0];
                        tabGroups[groupId] ??= [];
                        tabGroups[groupId].push(tab);
                    }
                }

                for (const [groupId, tabs] of Object.entries(tabGroups)) {
                    if (getHostname(targetTab.url) === getHostname(tabs[0].url)) {
                        let tabIndex = (await getTabInfo(tabs[0].id))?.index || 0;

                        if (config.stackname) {
                            try {
                                const stackNameMap = await vivaldi.prefs.get('vivaldi.tabs.stacking.name_map') || {};
                                let stackname;

                                switch (config.stackname) {
                                    case 1:
                                        stackname = getHostname(targetTab.url);
                                        break;
                                    case 2:
                                        stackname = getBaseDomain(targetTab.url).split('.')[0];
                                        stackname = stackname.charAt(0).toUpperCase() + stackname.slice(1);
                                        break;
                                }
                                await vivaldi.prefs.set({
                                    path: 'vivaldi.tabs.stacking.name_map',
                                    value: Object.assign(stackNameMap, { [groupId]: stackname }),
                                });
                            } catch (e) {
                                console.error('Error setting stack name:', e);
                            }
                        }

                        for (const tab of tabs) {
                            if (tab.vivExtData.group !== groupId) {
                                await addTabGroup(tab.id, groupId);
                            }
                            await chrome.tabs.move(tab.id, { index: tabIndex });
                            tabIndex++;
                        }
                    }
                }
            }
        } catch (e) {
            console.error('Error in groupingTabs:', e);
        }
    };

    try {
        chrome.webNavigation.onCommitted.addListener(async (details) => {
            try {
                const tab = await getTabInfo(details.tabId);

                if (tab && !tab.pinned && !tab.vivExtData.panelId && details.frameType === 'outermost_frame') {
                    setTimeout(() => {
                        groupingTabs(tab);
                    }, 100);
                }
            } catch (e) {
                console.error('Error in onCommitted listener:', e);
            }
        });
        
        console.log('Vivaldi Auto Tab Grouping extension initialized');
    } catch (e) {
        console.error('Error initializing extension:', e);
    }
})();
