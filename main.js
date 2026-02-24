'use strict';

const utils = require('@iobroker/adapter-core');
const axios = require('axios');


function isTrue(v) { return v === true || v === 'true' || v === 1 || v === '1' || v === 'on' || v === 'yes'; }
class CptAdapter extends utils.Adapter {
    constructor(options) {
        super({ ...options, name: 'cpt' });

        this.pollInterval = null;

        // cache last derived status per station for transition detection
        this.lastStatusByStation = {};
        this.lastFreePortsByStation = {};
        this.stationPrefixByName = {};

        this.on('message', this.onMessage.bind(this));
        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    makeSafeName(name) {
        return (name || '')
            .toString()
            .toLowerCase()
            .replace(/[^a-z0-9]/g, '_')
            .replace(/_+/g, '_')
            .replace(/^_+|_+$/g, '');
    }

    normalizeStatus(val) {
        const s = (val ?? 'unknown').toString().toLowerCase();
        return s || 'unknown';
    }

    deriveStationStatusFromPorts(ports) {
        const statuses = (Array.isArray(ports) ? ports : []).map((p) => this.normalizeStatus(p?.statusV2 || p?.status));
        if (statuses.some((s) => ['in_use', 'charging', 'occupied'].includes(s))) return 'in_use';
        if (statuses.some((s) => s === 'available')) return 'available';
        if (statuses.some((s) => ['unavailable', 'out_of_service', 'faulted', 'offline'].includes(s))) return 'unavailable';
        return statuses[0] || 'unknown';
    }

    pickCity(data1, data2) {
        const c1 = data1?.address?.city;
        const c2 = data2?.address?.city;
        return (c1 || c2 || 'Unbekannt').toString().trim() || 'Unbekannt';
    }

    getStationKey(station) {
        const base = station.name ? station.name : `station_${station.deviceId1}`;
        return this.makeSafeName(base) || `station_${station.deviceId1}`;
    }

    async ensureCityChannel(cityPrefix, cityName) {
        await this.setObjectNotExistsAsync(cityPrefix, { type: 'channel', common: { name: cityName }, native: {} });
    }

    async ensureToolsObjects() {
        await this.setObjectNotExistsAsync('tools', { type: 'channel', common: { name: 'Tools' }, native: {} });

        await this.setObjectNotExistsAsync('tools.export', {
            type: 'state',
            common: { name: 'Export Stationen (Trigger)', type: 'boolean', role: 'button', read: true, write: true, def: false },
            native: {},
        });

        await this.setObjectNotExistsAsync('tools.exportJson', {
            type: 'state',
            common: { name: 'Export JSON', type: 'string', role: 'json', read: true, write: false },
            native: {},
        });

        await this.setObjectNotExistsAsync('tools.exportFile', {
            type: 'state',
            common: { name: 'Export Datei (Adapter-Datenverzeichnis)', type: 'string', role: 'text', read: true, write: false },
            native: {},
        });

        await this.setObjectNotExistsAsync('tools.lastExport', {
            type: 'state',
            common: { name: 'Letzter Export', type: 'string', role: 'date', read: true, write: false },
            native: {},
        });

        // NEW: Test communication button + result
        await this.setObjectNotExistsAsync('tools.testNotifyAll', {
            type: 'state',
            common: { name: 'Test: Notify ALL (Trigger)', type: 'boolean', role: 'button', read: true, write: true, def: false },
            native: {},
        });

        await this.setObjectNotExistsAsync('tools.testNotify', {
            type: 'state',
            common: { name: 'Kommunikation testen (Trigger)', type: 'boolean', role: 'button', read: true, write: true, def: false },
            native: {},
        });

        await this.setObjectNotExistsAsync('tools.lastTest', {
            type: 'state',
            common: { name: 'Letzter Test', type: 'string', role: 'date', read: true, write: false },
            native: {},
        });

        await this.setObjectNotExistsAsync('tools.lastTestResult', {
            type: 'state',
            common: { name: 'Letztes Testergebnis', type: 'string', role: 'text', read: true, write: false },
            native: {},
        });

        await this.setStateAsync('tools.export', { val: false, ack: true });
        await this.setStateAsync('tools.testNotify', { val: false, ack: true });
    }

    async ensureStationObjects(stationPrefix, station) {
        await this.setObjectNotExistsAsync(stationPrefix, { type: 'channel', common: { name: station.name }, native: {} });

        await this.setObjectNotExistsAsync(`${stationPrefix}.deviceId1`, {
            type: 'state',
            common: { name: 'Device ID (P1)', type: 'string', role: 'value', read: true, write: false },
            native: {},
        });
        await this.setStateAsync(`${stationPrefix}.deviceId1`, { val: String(station.deviceId1), ack: true });

        await this.setObjectNotExistsAsync(`${stationPrefix}.deviceId2`, {
            type: 'state',
            common: { name: 'Device ID (P2)', type: 'string', role: 'value', read: true, write: false },
            native: {},
        });
        await this.setStateAsync(`${stationPrefix}.deviceId2`, { val: station.deviceId2 ? String(station.deviceId2) : '', ack: true });

        await this.setObjectNotExistsAsync(`${stationPrefix}.enabled`, {
            type: 'state',
            common: { name: 'Aktiv', type: 'boolean', role: 'indicator', read: true, write: false },
            native: {},
        });
        await this.setStateAsync(`${stationPrefix}.enabled`, { val: !!station.enabled, ack: true });

        // Per station notify flag (writable)
        await this.setObjectNotExistsAsync(`${stationPrefix}.testNotify`, {
            type: 'state',
            common: { name: 'Test: Notify (Button)', type: 'boolean', role: 'button', read: true, write: true, def: false },
            native: {},
        });

        await this.setObjectNotExistsAsync(`${stationPrefix}.notifyOnAvailable`, {
            type: 'state',
            common: { name: 'Benachrichtigen wenn verfügbar', type: 'boolean', role: 'switch', read: true, write: true, def: false },
            native: {},
        });
        const curNotify = await this.getStateAsync(`${stationPrefix}.notifyOnAvailable`);
        if (!curNotify || curNotify.val === null || curNotify.val === undefined) {
            await this.setStateAsync(`${stationPrefix}.notifyOnAvailable`, { val: !!station.notifyOnAvailable, ack: true });
        }

        await this.setObjectNotExistsAsync(`${stationPrefix}.statusDerived`, {
            type: 'state',
            common: { name: 'Status (aus Ports)', type: 'string', role: 'value', read: true, write: false },
            native: {},
        });

        await this.setObjectNotExistsAsync(`${stationPrefix}.portCount`, {
            type: 'state',
            common: { name: 'Anzahl Ports', type: 'number', role: 'value', read: true, write: false },
            native: {},
        });

        await this.setObjectNotExistsAsync(`${stationPrefix}.freePorts`, {
            type: 'state',
            common: { name: 'Freie Ports', type: 'number', role: 'value', read: true, write: false },
            native: {},
        });

        await this.setObjectNotExistsAsync(`${stationPrefix}.lastUpdate`, {
            type: 'state',
            common: { name: 'Letztes Update', type: 'string', role: 'date', read: true, write: false },
            native: {},
        });

        await this.setObjectNotExistsAsync(`${stationPrefix}.ports`, { type: 'channel', common: { name: 'Ports' }, native: {} });
    }

    async ensurePortObjects(stationPrefix, outletNumber) {
        const portPrefix = `${stationPrefix}.ports.${outletNumber}`;
        await this.setObjectNotExistsAsync(portPrefix, { type: 'channel', common: { name: `Port ${outletNumber}` }, native: {} });

        const states = [
            ['status', { name: 'Status', type: 'string', role: 'value' }],
            ['statusV2', { name: 'StatusV2', type: 'string', role: 'value' }],
            ['evseId', { name: 'EVSE ID', type: 'string', role: 'value' }],
            ['maxPowerKw', { name: 'Max Power', type: 'number', role: 'value.power', unit: 'kW' }],
            ['level', { name: 'Level', type: 'string', role: 'text' }],
            ['displayLevel', { name: 'Display Level', type: 'string', role: 'text' }],
            ['plugType', { name: 'Plug Type', type: 'string', role: 'text' }],
            ['displayPlugType', { name: 'Display Plug Type', type: 'string', role: 'text' }],
            ['lastUpdate', { name: 'Letztes Update', type: 'string', role: 'date' }],
        ];

        for (const [k, meta] of states) {
            await this.setObjectNotExistsAsync(`${portPrefix}.${k}`, {
                type: 'state',
                common: {
                    name: meta.name,
                    type: meta.type,
                    role: meta.role,
                    read: true,
                    write: false,
                    ...(meta.unit ? { unit: meta.unit } : {}),
                },
                native: {},
            });
        }
    }

    async setPortState(portPrefix, key, val) {
        await this.setStateAsync(`${portPrefix}.${key}`, { val: val ?? '', ack: true });
    }

    async onReady() {
        // config
        this.log.info(`starting. Version ${this.version}`);

        const intervalMin = Number(this.config.interval) || 5;
        this.log.info(`Polling-Intervall: ${intervalMin} Minuten, Stationen: ${(this.config.stations || []).length}`);

        await this.ensureToolsObjects();

        // ensure station object tree for enabled stations
        const stations = Array.isArray(this.config.stations) ? this.config.stations : [];
        for (const st of stations) {
            if (!st || !st.enabled) continue;

            const stationKey = this.getStationKey(st);
            const tmpPrefix = `stations.unknown.${stationKey}`; // city will be fixed after first poll
            await this.setObjectNotExistsAsync(`stations`, { type: 'channel', common: { name: 'Stationen' }, native: {} });
            await this.setObjectNotExistsAsync(`stations.unknown`, { type: 'channel', common: { name: 'Unbekannt' }, native: {} });
            await this.ensureStationObjects(tmpPrefix, st);
        }

        // subscribe to buttons
        this.subscribeStates('tools.export');
        this.subscribeStates('tools.testNotify');
        this.subscribeStates('tools.testNotifyAll');
        this.subscribeStates('stations.*.*.testNotify');
        this.subscribeStates('stations.*.*.notifyOnAvailable');

        // start polling
        await this.pollOnce();

        if (this.pollInterval) clearInterval(this.pollInterval);
        this.pollInterval = setInterval(() => this.pollOnce().catch((e) => this.log.warn(`Poll failed: ${e.message}`)), intervalMin * 60 * 1000);
    }

    async onStateChange(id, state) {
        if (!state) return;

        if (id === `${this.namespace}.tools.export` && isTrue(state.val) && !state.ack) {
            await this.setStateAsync('tools.export', { val: false, ack: true });
            await this.exportStationsJson();
        }

        if (id === `${this.namespace}.tools.testNotify` && isTrue(state.val) && !state.ack) {
            await this.setStateAsync('tools.testNotify', { val: false, ack: true });
            await this.testNotify();
        }

        if (id === `${this.namespace}.tools.testNotifyAll` && isTrue(state.val) && !state.ack) {
            await this.setStateAsync('tools.testNotifyAll', { val: false, ack: true });
            await this.testNotifyAll();
        }

        // per station test notify
        if (id.endsWith('.testNotify') && id.startsWith(this.namespace + '.stations.') && isTrue(state.val) && !state.ack) {
            await this.setStateAsync(id, { val: false, ack: true });
            const parts = id.replace(this.namespace + '.', '').split('.');
            const stationPrefix = parts.slice(0, -1).join('.');
            await this.testNotifyStation(stationPrefix);
        }

        // writable notifyOnAvailable update local config? (optional)
    }

    async onMessage(obj) {
        if (!obj) return;

        // Provide dropdown options for admin/jsonConfig
        if (obj.command === 'getStations') {
            try {
                const list = await this.getStatesAsync(this.namespace + '.stations.*.*.name');
                const opts = [];
                for (const [id, st] of Object.entries(list || {})) {
                    const prefix = id.replace(/\.name$/, '').replace(this.namespace + '.', '');
                    const stationName = st?.val ? String(st.val) : prefix.split('.').pop();
                    const parts = prefix.split('.');
                    const city = parts.length >= 2 ? parts[1] : '';
                    opts.push({ value: prefix, label: `${city} / ${stationName}` });
                }
                // IMPORTANT: selectSendTo expects an array of {label,value}, not {options: ...}
                obj.callback && this.sendTo(obj.from, obj.command, opts, obj.callback);
            } catch (e) {
                obj.callback && this.sendTo(obj.from, obj.command, [], obj.callback);
            }
            return;
        }

        if (obj.command === 'getRecipients') {
            // Return ALL configured channels (not only enabled) so the dropdown is never empty.
            // The subscription stores the label string; notifySubscribers filters by onlyLabel.
            const channels = Array.isArray(this.config.channels) ? this.config.channels : [];
            const labels = new Set();
            for (const ch of channels) {
                if (!ch) continue;
                const lbl = (ch.label || ch.name || ch.instance || '').toString().trim();
                if (lbl) labels.add(lbl);
            }
            const opts = Array.from(labels)
                .sort((a, b) => a.localeCompare(b, 'de', { sensitivity: 'base' }))
                .map((l) => ({ value: l, label: l }));
            // IMPORTANT: selectSendTo expects an array of {label,value}, not {options: ...}
            obj.callback && this.sendTo(obj.from, obj.command, opts, obj.callback);
            return;
        }

        if (obj.command === 'testChannel') {
            const instance = (obj.message?.instance || '').toString().trim();
            const user = (obj.message?.user || '').toString().trim();
            const label = (obj.message?.label || '').toString().trim();

            if (!instance) {
                obj.callback && this.sendTo(obj.from, obj.command, { error: 'Kein Adapter-Instanz gesetzt' }, obj.callback);
                return;
            }

            try {
                const inst = instance;
                const u = user;
                const lbl = label;
                const isTelegram = inst.startsWith('telegram.');
                const isWhatsAppCmb = inst.startsWith('whatsapp-cmb.');
                const isPushover = inst.startsWith('pushover.');
                let payload;
                if (isTelegram) {
                    payload = { text: 'CPT Test: Kommunikation OK ✅', ...(u ? { user: u } : {}) };
                } else if (isWhatsAppCmb) {
                    payload = {
                        phone: u || undefined,
                        number: u || undefined,
                        to: u || undefined,
                        text: 'CPT Test: Kommunikation OK ✅',
                        message: 'CPT Test: Kommunikation OK ✅',
                        title: 'ChargePoint',
                        channelLabel: lbl || undefined,
                    };
                } else if (isPushover) {
                    payload = { message: 'CPT Test: Kommunikation OK ✅', sound: '' };
                } else {
                    payload = {
                        text: 'CPT Test: Kommunikation OK ✅',
                        user: u || undefined,
                        chatId: u || undefined,
                        phone: u || undefined,
                        title: 'ChargePoint',
                        channelLabel: lbl || undefined,
                    };
                }
                Object.keys(payload).forEach((k) => payload[k] === undefined && delete payload[k]);

                // Send to target notification adapter
                this.sendTo(instance, 'send', payload);

                // Reply to admin UI (toast)
                obj.callback && this.sendTo(obj.from, obj.command, { ok: true }, obj.callback);
            } catch (e) {
                obj.callback && this.sendTo(obj.from, obj.command, { error: e.message }, obj.callback);
            }
            return;
        }

        if (obj.command === 'testStationNotify') {
            const stationName = (obj.message?.stationName || '').toString().trim();
            try {
                await this.sendMessageToChannels(`CPT Test: Station ${stationName} ✅`, {});
                obj.callback && this.sendTo(obj.from, obj.command, { ok: true }, obj.callback);
            } catch (e) {
                obj.callback && this.sendTo(obj.from, obj.command, { error: e.message }, obj.callback);
            }
            return;
        }
    }

    async exportStationsJson() {
        try {
            const stations = Array.isArray(this.config.stations) ? this.config.stations : [];
            const out = stations.map((s) => ({
                enabled: !!s.enabled,
                name: s.name || '',
                deviceId1: s.deviceId1 || null,
                deviceId2: s.deviceId2 || null,
            }));
            const json = JSON.stringify(out, null, 2);
            await this.setStateAsync('tools.exportJson', { val: json, ack: true });
            await this.setStateAsync('tools.lastExport', { val: new Date().toISOString(), ack: true });
            await this.setStateAsync('tools.exportFile', { val: '', ack: true });
            this.log.info('Export JSON aktualisiert');
        } catch (e) {
            this.log.warn(`Export fehlgeschlagen: ${e.message}`);
        }
    }

    getActiveChannels(ctx = {}) {
        const channels = this.config.channels;
        let arr = channels;
        if (arr && !Array.isArray(arr) && typeof arr === 'object') arr = Object.values(arr);
        if (typeof arr === 'string') {
            try { arr = JSON.parse(arr); } catch (e) { arr = []; }
        }
        if (!Array.isArray(arr)) arr = [];

        let active = arr.filter(c => c && isTrue(c.enabled));
        if (ctx.onlyInstance) {
            active = active.filter(c => String(c.instance) === String(ctx.onlyInstance));
        }
        if (ctx.onlyLabel) {
            active = active.filter(c => String(c.label || c.name || '').toLowerCase() === String(ctx.onlyLabel).toLowerCase());
        }
        return active;
    }

    async sendMessageToChannels(text, ctx = {}) {
        const active = this.getActiveChannels(ctx);
        if (active.length === 0) {
            this.log.warn('Keine aktiven Kanäle für Benachrichtigung konfiguriert');
            return;
        }

        for (const ch of active) {
            const instance = (ch.instance || '').toString().trim();
            const user = (ch.user || '').toString().trim();
            const label = (ch.label || ch.name || '').toString().trim();

            if (!instance) continue;

            try {
                if (instance.startsWith('telegram.')) {
                    const payload = { text: text };
                    if (user) payload.user = user;
                    this.sendTo(instance, 'send', payload);
                } else if (instance.startsWith('whatsapp-cmb.')) {
                    const payload = {
                        phone: user || undefined,
                        number: user || undefined,
                        to: user || undefined,
                        text: text,
                        message: text,
                        title: 'ChargePoint',
                        channelLabel: label || undefined,
                    };
                    Object.keys(payload).forEach((k) => payload[k] === undefined && delete payload[k]);
                    this.sendTo(instance, 'send', payload);
                } else if (instance.startsWith('pushover.')) {
                    const payload = { message: text };
                    this.sendTo(instance, 'send', payload);
                } else {
                    const payload = {
                        text: text,
                        user: user || undefined,
                        title: 'ChargePoint',
                        channelLabel: label || undefined,
                    };
                    Object.keys(payload).forEach((k) => payload[k] === undefined && delete payload[k]);
                    this.sendTo(instance, 'send', payload);
                }
            } catch (e) {
                this.log.warn(`Benachrichtigung fehlgeschlagen (${instance}): ${e.message}`);
            }
        }
    }

    async testNotify() {
        try {
            await this.sendMessageToChannels('CPT Test: Kommunikation OK ✅', {});
            await this.setStateAsync('tools.lastTest', { val: new Date().toISOString(), ack: true });
            await this.setStateAsync('tools.lastTestResult', { val: 'OK', ack: true });
        } catch (e) {
            await this.setStateAsync('tools.lastTest', { val: new Date().toISOString(), ack: true });
            await this.setStateAsync('tools.lastTestResult', { val: `ERROR: ${e.message}`, ack: true });
        }
    }

    async testNotifyAll() {
        await this.sendMessageToChannels('CPT Test ALL: Kommunikation OK ✅', {});
        await this.setStateAsync('tools.lastTest', { val: new Date().toISOString(), ack: true });
        await this.setStateAsync('tools.lastTestResult', { val: 'OK (ALL)', ack: true });
    }

    async testNotifyStation(stationPrefix) {
        try {
            const nameState = await this.getStateAsync(`${stationPrefix}.name`).catch(() => null);
            const stationName = nameState?.val ? String(nameState.val) : stationPrefix.split('.').pop();
            const cityName = stationPrefix.split('.')[1] || '';
            await this.sendMessageToChannels(`CPT Test: Station ${stationName} (${cityName}) ✅`, {});
            this.log.info(`TEST Notify gesendet: ${stationName} (${cityName})`);
        } catch (e) {
            this.log.warn(`TEST Notify fehlgeschlagen für ${stationPrefix}: ${e.message}`);
        }
    }

    safeCityKey(city) {
        const c = (city || '').toString().trim();
        const safe = this.makeSafeName(c);
        return safe || 'unbekannt';
    }

    async pollOnce() {
        const stations = Array.isArray(this.config.stations) ? this.config.stations : [];
        for (const st of stations) {
            if (!st || !st.enabled) continue;

            const stationKey = this.getStationKey(st);
            const tmpPrefix = `stations.unknown.${stationKey}`;

            const deviceIds = [st.deviceId1, st.deviceId2].filter(Boolean).map(Number);
            if (deviceIds.length === 0) continue;

            try {
                const responses = [];
                for (const devId of deviceIds) {
                    const url = `https://mc.chargepoint.com/map-prod/v3/station/info?deviceId=${devId}`;
                    this.log.debug(`GET ${url}`);
                    const resp = await axios.get(url, { timeout: 15000 });
                    responses.push(resp.data);
                }

                const data1 = responses[0];
                const data2 = responses[1];

                const city = this.pickCity(data1, data2);
                const cityKey = this.safeCityKey(city);
                const stationPrefix = `stations.${cityKey}.${stationKey}`;
                st._lastCity = city;
                await this.setObjectNotExistsAsync('stations', { type: 'channel', common: { name: 'Stationen' }, native: {} });
                await this.ensureCityChannel(`stations.${cityKey}`, city);
                await this.ensureStationObjects(stationPrefix, st);

                this.stationPrefixByName[st.name] = stationPrefix;

                // move from unknown if needed (not deleting automatically here)
                // build ports list
                const ports = [];
                for (const stationData of responses) {
                    const evses = stationData?.evses || stationData?.ports || [];
                    for (const evse of evses) {
                        const outletNumber = Number(evse?.outletNumber || evse?.outlet || evse?.outlet_number || evse?.portNumber || evse?.port || 0) || 0;
                        if (!outletNumber) continue;
                        ports.push({
                            outletNumber,
                            status: evse?.status,
                            statusV2: evse?.statusV2 || evse?.status_v2,
                            evseId: evse?.evseId || evse?.evse_id,
                            maxPowerKw: evse?.maxPowerKw || evse?.max_power_kw,
                            level: evse?.level,
                            displayLevel: evse?.displayLevel || evse?.display_level,
                            plugType: evse?.plugType || evse?.plug_type,
                            displayPlugType: evse?.displayPlugType || evse?.display_plug_type,
                        });
                    }
                }

                // ensure per port objects and write states
                for (const p of ports) {
                    await this.ensurePortObjects(stationPrefix, p.outletNumber);
                    const portPrefix = `${stationPrefix}.ports.${p.outletNumber}`;
                    await this.setPortState(portPrefix, 'status', this.normalizeStatus(p.status));
                    await this.setPortState(portPrefix, 'statusV2', this.normalizeStatus(p.statusV2));
                    await this.setPortState(portPrefix, 'evseId', p.evseId ?? '');
                    await this.setPortState(portPrefix, 'maxPowerKw', p.maxPowerKw ?? 0);
                    await this.setPortState(portPrefix, 'level', p.level ?? '');
                    await this.setPortState(portPrefix, 'displayLevel', p.displayLevel ?? '');
                    await this.setPortState(portPrefix, 'plugType', p.plugType ?? '');
                    await this.setPortState(portPrefix, 'displayPlugType', p.displayPlugType ?? '');
                    await this.setPortState(portPrefix, 'lastUpdate', new Date().toISOString());
                }

                const portCount = ports.length;
                const freePorts = ports.filter((p) => this.normalizeStatus(p.statusV2 || p.status) === 'available').length;

                const derived = this.deriveStationStatusFromPorts(ports);

                await this.setStateAsync(`${stationPrefix}.portCount`, { val: portCount, ack: true });
                await this.setStateAsync(`${stationPrefix}.freePorts`, { val: freePorts, ack: true });
                await this.setStateAsync(`${stationPrefix}.statusDerived`, { val: derived, ack: true });
                await this.setStateAsync(`${stationPrefix}.lastUpdate`, { val: new Date().toISOString(), ack: true });

                const prevDerived = this.lastStatusByStation[stationPrefix];
                const prevFree = this.lastFreePortsByStation[stationPrefix];

                const changed = (prevDerived !== derived) || (prevFree !== freePorts);

                this.lastStatusByStation[stationPrefix] = derived;
                this.lastFreePortsByStation[stationPrefix] = freePorts;

                if (changed) {
                    this.log.debug(`Aktualisiert: ${st.name} city=${city} freePorts=${freePorts}/${portCount} derived=${derived}`);
                }

                // notify on transition to available
                const notifyState = await this.getStateAsync(`${stationPrefix}.notifyOnAvailable`).catch(() => null);
                const notifyOnAvail = notifyState ? isTrue(notifyState.val) : !!st.notifyOnAvailable;

                if (notifyOnAvail && prevDerived && prevDerived !== 'available' && derived === 'available') {
                    await this.notifySubscribers({ stationPrefix, city, stationName: st.name, freePorts, portCount, isTest: false });
                }
            } catch (e) {
                this.log.warn(`Poll Fehler für ${st.name}: ${e.message}`);
            }
        }
    }

    getStationsList() {
        const stations = Array.isArray(this.config.stations) ? this.config.stations : [];
        const out = [];
        for (const st of stations) {
            if (!st) continue;
            const cityKey = this.safeCityKey(st._lastCity || st.city || 'unknown');
            const stationKey = this.getStationKey(st);
            const prefix = `stations.${cityKey}.${stationKey}`;
            const label = `${st._lastCity || st.city || cityKey} / ${st.name || stationKey}`;
            out.push({ value: prefix, label });
        }
        return out;
    }

    getRecipientsList() {
        const channels = Array.isArray(this.config.channels) ? this.config.channels : [];
        const labels = new Set();
        for (const ch of channels) {
            if (!ch) continue;
            const lbl = (ch.label || ch.name || ch.instance || '').toString().trim();
            if (lbl) labels.add(lbl);
        }
        return Array.from(labels)
            .sort((a, b) => a.localeCompare(b, 'de', { sensitivity: 'base' }))
            .map((l) => ({ value: l, label: l }));
    }

    async notifySubscribers({ stationPrefix, city, stationName, freePorts, portCount, isTest = false }) {
        const subsRaw = this.config.subscriptions || [];
        let subs = subsRaw;
        if (subs && !Array.isArray(subs) && typeof subs === 'object') subs = Object.values(subs);
        if (typeof subs === 'string') {
            try { subs = JSON.parse(subs); } catch (e) { subs = []; }
        }
        if (!Array.isArray(subs)) subs = [];

        const matchSubs = subs.filter(s => s && isTrue(s.enabled) && String(s.station) === String(stationPrefix));
        const text = `Ladestation ${stationName} ist nun frei`;

        if (matchSubs.length === 0) {
            if (isTest) {
                // Fallback: send to all active channels on test
                await this.sendMessageToChannels(text, {});
            }
            return;
        }

        for (const sub of matchSubs) {
            const recipient = sub.recipient || sub.user || sub.label || '';
            if (!recipient) continue;
            await this.sendMessageToChannels(text, { onlyLabel: recipient });
        }
    }

    onUnload(callback) {
        try {
            if (this.pollInterval) clearInterval(this.pollInterval);
            callback();
        } catch (e) {
            callback();
        }
    }
}

if (require.main !== module) {
    module.exports = (options) => new CptAdapter(options);
} else {
    new CptAdapter();
}