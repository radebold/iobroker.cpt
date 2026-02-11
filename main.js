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

        for (const [id, common] of states) {
            await this.setObjectNotExistsAsync(`${portPrefix}.${id}`, { type: 'state', common: { read: true, write: false, ...common }, native: {} });
        }
        return portPrefix;
    }

    async cleanupRemovedStations(allowedStationChannels, allowedCityChannels) {
        const startkey = `${this.namespace}.stations.`;
        const endkey = `${this.namespace}.stations.\u9999`;

        const view = await this.getObjectViewAsync('system', 'channel', { startkey, endkey });
        const rows = view?.rows || [];

        for (const row of rows) {
            const id = row.id;
            const rel = id.substring(`${this.namespace}.`.length);
            const parts = rel.split('.');
            if (parts.length === 3 && parts[0] === 'stations') {
                if (!allowedStationChannels.has(id)) {
                    this.log.info(`Station nicht mehr in Config → lösche Objekte rekursiv: ${id}`);
                    await this.delObjectAsync(id, { recursive: true });
                }
            }
        }

        const view2 = await this.getObjectViewAsync('system', 'channel', { startkey, endkey });
        const rows2 = view2?.rows || [];
        for (const row of rows2) {
            const id = row.id;
            const rel = id.substring(`${this.namespace}.`.length);
            const parts = rel.split('.');
            if (parts.length === 2 && parts[0] === 'stations') {
                if (!allowedCityChannels.has(id)) {
                    this.log.info(`Ort nicht mehr in Config → lösche Channel rekursiv: ${id}`);
                    await this.delObjectAsync(id, { recursive: true });
                }
            }
        }
    }

    onMessage(obj) {
        if (!obj || !obj.command) return;

        if (obj.command === 'testStation') {
            const name = obj.message?.name || obj.message?.station || '';
            const deviceId1 = obj.message?.deviceId1;
            const station = (Array.isArray(this.config.stations) ? this.config.stations : []).find((s) =>
                s && (s.name === name || String(s.deviceId1) === String(deviceId1))
            );

            const stationName = station?.name || name || 'Station';
            const city = obj.message?.city || '';
            const text = `Ladestation ${stationName}${city ? ' (' + city + ')' : ''}: TEST Nachricht`;

            this.sendMessageToChannels(text, { station: stationName, city, isTest: true })
                .then((res) => {
                    const out = `TEST gesendet: ok=${res.ok}, failed=${res.failed}\n${(res.details || []).join('\n')}`;
                    obj.callback && this.sendTo(obj.from, obj.command, out, obj.callback);
                })
                .catch((e) => {
                    obj.callback && this.sendTo(obj.from, obj.command, `TEST Fehler: ${e.message}`, obj.callback);
                });
            return;
        }
    }

    getChannels() {
        const raw = Array.isArray(this.config.channels) ? this.config.channels : [];
        // keep only enabled rows and only supported adapters
        return raw
            .filter((c) => c && isTrue(c.enabled) && typeof c.instance === 'string' && c.instance.trim())
            .filter((c) => {
                const inst = c.instance.trim();
                return inst.startsWith('telegram.') || inst.startsWith('whatsapp-cmb.') || inst.startsWith('pushover.');
            })
            .map((c) => ({
                instance: String(c.instance).trim(),
                user: (c.user ?? '').toString().trim(),
                label: (c.label ?? '').toString().trim(),
            }));
    }

    async sendMessageToChannels(text, ctx = {}) {async sendMessageToChannels(text, ctx = {}) {
        const channels = (typeof this.getChannels === 'function' ? this.getChannels() : []) || [];
        if (!Array.isArray(channels) || channels.length === 0) {
            this.log.debug('Keine Kommunikationskanäle konfiguriert – Versand übersprungen');
            return { ok: 0, failed: 0, details: [], note: 'no_channels' };
        }

        const sendToAsync = (instance, command, message) =>
            new Promise((resolve, reject) => {
                try {
                    this.sendTo(instance, command, message, (resp) => resolve(resp));
                } catch (e) {
                    reject(e);
                }
            });

        let ok = 0;
        let failed = 0;
        const details = [];

        for (const ch of channels) {
            const inst = ch.instance;
            const u = ch.user;
            const lbl = ch.label;

            const isTelegram = inst.startsWith('telegram.');
            const isWhatsAppCmb = inst.startsWith('whatsapp-cmb.');
            const isPushover = inst.startsWith('pushover.');

            let payload;
            if (isTelegram) {
                // Telegram: user is optional (alias/chatId configured in Telegram adapter)
                payload = u ? { text, user: u } : { text };
            } else if (isWhatsAppCmb) {
                // WhatsApp-CMB: receiver is the phone number, e.g. +49...
                payload = { phone: u, text };
            } else if (isPushover) {
                // Pushover: receiver/user key is configured in the Pushover adapter itself
                payload = { message: text, sound: '' };
            } else {
                payload = { text };
            }

            // add some context (harmless if adapter ignores unknown fields)
            if (ctx && typeof ctx === 'object') {
                if (ctx.city) payload.city = ctx.city;
                if (ctx.station) payload.station = ctx.station;
                if (ctx.freePorts !== undefined) payload.freePorts = ctx.freePorts;
                if (ctx.portCount !== undefined) payload.portCount = ctx.portCount;
                if (ctx.status) payload.status = ctx.status;
            }

            try {
                await sendToAsync(inst, 'send', payload);
                ok++;
                details.push(`OK: ${inst}${lbl ? ' (' + lbl + ')' : ''}`);
            } catch (e) {
                failed++;
                details.push(`FAIL: ${inst}${lbl ? ' (' + lbl + ')' : ''}: ${e.message}`);
                this.log.warn(`Notify failed for ${inst}${lbl ? ' (' + lbl + ')' : ''}: ${e.message}`);
            }
        }

        return { ok, failed, details };
    }


    async sendAvailableNotification(ctx) {
        const prefix = ctx.isTest ? 'TEST: ' : '';
        const text = `${prefix}Ladestation ${ctx.station} in ${ctx.city} ist nun frei${ctx.freePorts !== undefined && ctx.portCount !== undefined ? ` (${ctx.freePorts}/${ctx.portCount})` : ''}`;
        return this.sendMessageToChannels(text, ctx);
    }


    async sendTestNotifyForPrefix(stationPrefix) {
        // stationPrefix is like "stations.city.station"
        try {
            const cityKey = stationPrefix.split('.')[1] || 'unbekannt';
            const stationKey = stationPrefix.split('.')[2] || 'station';
            // Try to get friendly names from states (fallback to keys)
            const nameState = await this.getStateAsync(`${stationPrefix}.name`).catch(() => null);
            const cityState = await this.getStateAsync(`${stationPrefix}.city`).catch(() => null);
            const freePortsState = await this.getStateAsync(`${stationPrefix}.freePorts`).catch(() => null);
            const portCountState = await this.getStateAsync(`${stationPrefix}.portCount`).catch(() => null);

            const stationName = (nameState && nameState.val) ? String(nameState.val) : stationKey;
            const cityName = (cityState && cityState.val) ? String(cityState.val) : cityKey;
            const freePorts = (freePortsState && freePortsState.val !== undefined) ? Number(freePortsState.val) : undefined;
            const portCount = (portCountState && portCountState.val !== undefined) ? Number(portCountState.val) : undefined;

            await this.sendAvailableNotification({
                isTest: true,
                station: stationName,
                city: cityName,
                freePorts,
                portCount,
            });

            this.log.info(`TEST Notify gesendet: ${stationName} (${cityName})`);
        } catch (e) {
            this.log.warn(`TEST Notify fehlgeschlagen für ${stationPrefix}: ${e.message}`);
        }
    }

    async onMessage(obj) {
        if (!obj) return;

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
                obj.callback && this.sendTo(
                    obj.from,
                    obj.command,
                    { data: { result: `Test an ${instance} gesendet${user ? ' (' + user + ')' : ''}` } },
                    obj.callback
                );
            } catch (e) {
                obj.callback && this.sendTo(obj.from, obj.command, { error: e.message }, obj.callback);
            }
            return;
        }
    }



    async onReady() {
        this.log.info('Adapter CPT gestartet');
        this.log.info('Konfiguration: ' + JSON.stringify(this.config));

        await this.ensureToolsObjects();
        this.subscribeStates('tools.export');
        this.subscribeStates('tools.testNotify');
        this.subscribeStates('tools.testNotifyAll');
        this.subscribeStates('stations.*.*.notifyOnAvailable');
        this.subscribeStates('stations.*.*.testNotify');
        this.subscribeStates('stations.*.*.statusDerived');

        const intervalMin = Number(this.config.interval) || 5;

        const stations = (Array.isArray(this.config.stations) ? this.config.stations : [])
            .filter((s) => s && typeof s === 'object')
            .map((s, idx) => {
                const deviceId1 = s.deviceId1 ?? s.stationId ?? s.deviceId ?? s.id;
                const deviceId2 = s.deviceId2 ?? null;
                const name = s.name || `station_${deviceId1 || idx + 1}`;
                const enabled = s.enabled !== false;
                return {
                    name,
                    enabled,
                    notifyOnAvailable: s.notifyOnAvailable === true,
                    deviceId1: deviceId1 ? Number(deviceId1) : null,
                    deviceId2: deviceId2 ? Number(deviceId2) : null,
                };
            })
            .filter((s) => !!s.deviceId1);

        this.log.info(`Anzahl Stationen (gültig): ${stations.length}`);
        this.log.info(`Polling-Intervall: ${intervalMin} Minuten`);

        const initialDataByStation = [];
        for (const st of stations) {
            const data1 = await this.safeFetch(st.deviceId1);
            const data2 = st.deviceId2 ? await this.safeFetch(st.deviceId2) : null;
            initialDataByStation.push({ st, data1, data2 });
        }

        const allowedStationChannels = new Set();
        const allowedCityChannels = new Set();

        for (const item of initialDataByStation) {
            const city = this.pickCity(item.data1, item.data2);
            const cityKey = this.makeSafeName(city) || 'unbekannt';
            const stationKey = this.getStationKey(item.st);
            const stationPrefix = `stations.${cityKey}.${stationKey}`;
            allowedStationChannels.add(`${this.namespace}.${stationPrefix}`);
            allowedCityChannels.add(`${this.namespace}.stations.${cityKey}`);
        }

        await this.cleanupRemovedStations(allowedStationChannels, allowedCityChannels);

        if (stations.length === 0) {
            this.log.warn('Keine gültigen Stationen konfiguriert');
            return;
        }

        for (const item of initialDataByStation) {
            const st = item.st;
            const city = this.pickCity(item.data1, item.data2);
            const cityKey = this.makeSafeName(city) || 'unbekannt';

            await this.ensureCityChannel(`stations.${cityKey}`, city);

            const stationKey = this.getStationKey(st);
            const stationPrefix = `stations.${cityKey}.${stationKey}`;
            await this.ensureStationObjects(stationPrefix, st);
            await this.setStateAsync(`${stationPrefix}.freePorts`, { val: 0, ack: true });
        }

        await this.updateAllStations(stations);

        this.pollInterval = setInterval(() => {
            this.updateAllStations(stations).catch((e) => this.log.error(`Polling-Fehler: ${e?.message || e}`));
        }, intervalMin * 60 * 1000);
    }

    async onStateChange(id, state) {
        if (!state || state.ack) return;
        // HANDLE_TESTNOTIFY: trigger test notifications via button-states
        if (id === this.namespace + '.tools.testNotifyAll' && state.val === true) {
            try {
                const notifStates = await this.getStatesAsync(this.namespace + '.stations.*.*.notifyOnAvailable');
                const prefixes = Object.keys(notifStates || {})
                    .filter(k => notifStates[k] && notifStates[k].val === true)
                    .map(k => k.replace(/\.notifyOnAvailable$/, ''))
                    .sort();

                if (!prefixes.length) {
                    this.log.warn('TEST Notify ALL: Keine Stationen mit notifyOnAvailable=true gefunden');
                } else {
                    for (const stationPrefix of prefixes) {
                        await this.sendTestNotifyForPrefix(stationPrefix);
                    }
                    this.log.info(`TEST Notify ALL: ${prefixes.length} Station(en) ausgelöst`);
                }
            } catch (e) {
                this.log.warn(`TEST Notify ALL fehlgeschlagen: ${e.message}`);
            } finally {
                await this.setStateAsync('tools.testNotifyAll', { val: false, ack: true });
            }
            return;
        }

        const mTest = id.match(new RegExp('^' + this.namespace.replace('.', '\\.') + '\\.stations\\.(.+?)\\.(.+?)\\.testNotify$'));
        if (mTest && state.val === true) {
            const cityKey = mTest[1];
            const stationKey = mTest[2];
            const stationPrefix = `stations.${cityKey}.${stationKey}`;

            try {
                await this.sendTestNotifyForPrefix(stationPrefix);
                this.log.info(`TEST Notify: ${stationPrefix} ausgelöst`);
            } catch (e) {
                this.log.warn(`TEST Notify fehlgeschlagen für ${stationPrefix}: ${e.message}`);
            } finally {
                await this.setStateAsync(`${stationPrefix}.testNotify`, { val: false, ack: true });
            }
            return;
        }

        // STATUS_DERIVED_MANUAL: allow manual testing from scripts (ack=false)
        // If statusDerived changes to "available" and notify flag is true, send a TEST notification.
        const mStatus = id.match(new RegExp('^' + this.namespace.replace('.', '\\.') + '\\.stations\\.(.+?)\\.(.+?)\\.statusDerived$'));
        if (mStatus) {
            const cityKey = mStatus[1];
            const stationKey = mStatus[2];
            const stationPrefix = `stations.${cityKey}.${stationKey}`;

            const newStatus = (state.val ?? '').toString();
            const oldStatus = this.lastStatusByStation[stationPrefix];

            // update cache immediately
            this.lastStatusByStation[stationPrefix] = newStatus;

            try {
                const notify = await this.getStateAsync(`${stationPrefix}.notifyOnAvailable`);
                const notifyEnabled = notify?.val === true;

                const wasAvailable = oldStatus === 'available';
                if (notifyEnabled && !wasAvailable && newStatus === 'available') {
                    const cityObj = await this.getObjectAsync(`stations.${cityKey}`);
                    const cityName = cityObj?.common?.name || cityKey;

                    const fp = await this.getStateAsync(`${stationPrefix}.freePorts`);
                    const pc = await this.getStateAsync(`${stationPrefix}.portCount`);

                    const freePorts = fp?.val !== undefined && fp?.val !== null ? Number(fp.val) : undefined;
                    const portCount = pc?.val !== undefined && pc?.val !== null ? Number(pc.val) : undefined;

                    await this.sendAvailableNotification({
                        city: cityName,
                        station: stationKey,
                        freePorts,
                        portCount,
                        status: newStatus,
                        isTest: true,
                    });

                    this.log.info(`Manual notify trigger (TEST): ${stationPrefix} ${oldStatus} -> ${newStatus}`);
                } else {
                    this.log.debug(`Manual statusDerived change ignored: ${stationPrefix} ${oldStatus} -> ${newStatus} (notify=${notifyEnabled})`);
                }
            } catch (e) {
                this.log.warn(`Manual statusDerived notify check failed for ${stationPrefix}: ${e.message}`);
            }
            return;
        }



        if (id === `${this.namespace}.tools.export` && state.val === true) {
            await this.doExportStations();
            await this.setStateAsync('tools.export', { val: false, ack: true });
            return;
        }

        if (id === `${this.namespace}.tools.testNotify` && state.val === true) {
            const now = new Date().toISOString();
            const res = await this.sendMessageToChannels('CPT Test: Kommunikation OK ✅');
            await this.setStateAsync('tools.lastTest', { val: now, ack: true });
            await this.setStateAsync('tools.lastTestResult', { val: `ok=${res.ok}, failed=${res.failed}`, ack: true });
            await this.setStateAsync('tools.testNotify', { val: false, ack: true });
            return;
        }
    }

    async doExportStations() {
        const stations = (Array.isArray(this.config.stations) ? this.config.stations : [])
            .filter((s) => s && typeof s === 'object')
            .map((s, idx) => ({
                enabled: s.enabled !== false,
                notifyOnAvailable: s.notifyOnAvailable === true,
                name: s.name || `station_${s.deviceId1 ?? s.stationId ?? s.deviceId ?? idx + 1}`,
                deviceId1: Number(s.deviceId1 ?? s.stationId ?? s.deviceId ?? s.id),
                deviceId2: s.deviceId2 ? Number(s.deviceId2) : null,
            }))
            .filter((s) => !!s.deviceId1);

        const payload = {
            exportedAt: new Date().toISOString(),
            adapter: 'cpt',
            version: this.version,
            interval: Number(this.config.interval) || 5,
            channels: Array.isArray(this.config.channels) ? this.config.channels : [],
            stations,
        };

        const jsonStr = JSON.stringify(payload, null, 2);

        await this.setStateAsync('tools.exportJson', { val: jsonStr, ack: true });

        const filename = 'stations_export.json';
        try {
            await this.writeFileAsync(this.namespace, filename, jsonStr);
            await this.setStateAsync('tools.exportFile', { val: filename, ack: true });
        } catch (e) {
            this.log.warn(`Konnte Export-Datei nicht schreiben: ${e.message}`);
            await this.setStateAsync('tools.exportFile', { val: '', ack: true });
        }

        await this.setStateAsync('tools.lastExport', { val: new Date().toISOString(), ack: true });
        this.log.info(`Export erstellt: ${stations.length} Station(en)`);
    }

    async safeFetch(deviceId) {
        try {
            const url = `https://mc.chargepoint.com/map-prod/v3/station/info?deviceId=${deviceId}`;
            this.log.debug(`GET ${url}`);
            const res = await axios.get(url, { timeout: 12000 });
            return res.data || {};
        } catch (e) {
            this.log.warn(`Fetch fehlgeschlagen für deviceId=${deviceId}: ${e.message}`);
            return null;
        }
    }

    buildLogicalPorts(data1, data2, hasSecondId) {
        if (hasSecondId) {
            const p1 = (data1?.portsInfo?.ports && data1.portsInfo.ports[0]) ? data1.portsInfo.ports[0] : {};
            const p2 = (data2?.portsInfo?.ports && data2.portsInfo.ports[0]) ? data2.portsInfo.ports[0] : {};
            return [{ ...p1, outletNumber: 1 }, { ...p2, outletNumber: 2 }];
        }
        const ports = Array.isArray(data1?.portsInfo?.ports) ? data1.portsInfo.ports : [];
        return ports;
    }

    async updateAllStations(stations) {
        for (const st of stations) {
            const data1 = await this.safeFetch(st.deviceId1);
            const data2 = st.deviceId2 ? await this.safeFetch(st.deviceId2) : null;

            const city = this.pickCity(data1, data2);
            const cityKey = this.makeSafeName(city) || 'unbekannt';
            const stationKey = this.getStationKey(st);
            const stationPrefix = `stations.${cityKey}.${stationKey}`;

            await this.ensureCityChannel(`stations.${cityKey}`, city);
            await this.ensureStationObjects(stationPrefix, st);

            const notifyState = await this.getStateAsync(`${stationPrefix}.notifyOnAvailable`);
            const notifyEnabled = notifyState?.val === true;

            if (st.enabled === false) {
                await this.setStateAsync(`${stationPrefix}.statusDerived`, { val: 'deaktiviert', ack: true });
                await this.setStateAsync(`${stationPrefix}.portCount`, { val: 0, ack: true });
                await this.setStateAsync(`${stationPrefix}.freePorts`, { val: 0, ack: true });
                await this.setStateAsync(`${stationPrefix}.lastUpdate`, { val: new Date().toISOString(), ack: true });
                continue;
            }

            const ports = this.buildLogicalPorts(data1, data2, !!st.deviceId2);
            const portCount = st.deviceId2 ? 2 : ports.length;
            const freePorts = ports.reduce((acc, p) => acc + (this.normalizeStatus(p?.statusV2 || p?.status) === 'available' ? 1 : 0), 0);
            const derived = this.deriveStationStatusFromPorts(ports);

            const prevState = await this.getStateAsync(`${stationPrefix}.statusDerived`);
            const prev = prevState?.val ? String(prevState.val) : undefined;

            await this.setStateAsync(`${stationPrefix}.portCount`, { val: portCount, ack: true });
            await this.setStateAsync(`${stationPrefix}.freePorts`, { val: freePorts, ack: true });
            await this.setStateAsync(`${stationPrefix}.statusDerived`, { val: derived, ack: true });
            this.lastStatusByStation[stationPrefix] = derived;

            // Notify when station becomes available based on freePorts transition: 0 -> >0
            const oldFreePorts = this.lastFreePortsByStation[stationPrefix];
            this.lastFreePortsByStation[stationPrefix] = freePorts;

            try {
                const notify = await this.getStateAsync(`${stationPrefix}.notifyOnAvailable`);
                const notifyEnabled = notify?.val === true;

                const becameFree = oldFreePorts !== undefined && Number(oldFreePorts) === 0 && Number(freePorts) > 0;
                if (notifyEnabled && becameFree) {
                    await this.sendAvailableNotification({
                        city,
                        station: stationName,
                        freePorts,
                        portCount,
                        status: derived,
                        isTest: false,
                    });
                    this.log.info(`Notify trigger: ${stationName} (${city}) freePorts ${oldFreePorts} -> ${freePorts}`);
                }
            } catch (e) {
                this.log.warn(`Notify check failed for ${stationPrefix}: ${e.message}`);
            }


            for (let i = 0; i < ports.length; i++) {
                const port = ports[i] || {};
                const outletNumber = port.outletNumber ?? (i + 1);
                const portPrefix = await this.ensurePortObjects(stationPrefix, outletNumber);

                const pStatus = port.status || 'unknown';
                const pStatusV2 = port.statusV2 || 'unknown';
                const evseId = port.evseId ? String(port.evseId) : '';

                let maxPowerKw = null;
                const prMax = port?.powerRange?.max;
                if (typeof prMax === 'number') {
                    maxPowerKw = prMax;
                } else if (typeof prMax === 'string') {
                    const parsed = Number(prMax);
                    if (!Number.isNaN(parsed)) maxPowerKw = parsed;
                }

                const level = port.level ? String(port.level) : '';
                const displayLevel = port.displayLevel ? String(port.displayLevel) : '';

                const connector0 = Array.isArray(port.connectorList) && port.connectorList.length > 0 ? port.connectorList[0] : null;
                const plugType = connector0?.plugType ? String(connector0.plugType) : '';
                const displayPlugType = connector0?.displayPlugType ? String(connector0.displayPlugType) : '';

                await this.setStateAsync(`${portPrefix}.status`, { val: pStatus, ack: true });
                await this.setStateAsync(`${portPrefix}.statusV2`, { val: pStatusV2, ack: true });
                await this.setStateAsync(`${portPrefix}.evseId`, { val: evseId, ack: true });
                if (maxPowerKw !== null) await this.setStateAsync(`${portPrefix}.maxPowerKw`, { val: maxPowerKw, ack: true });
                await this.setStateAsync(`${portPrefix}.level`, { val: level, ack: true });
                await this.setStateAsync(`${portPrefix}.displayLevel`, { val: displayLevel, ack: true });
                await this.setStateAsync(`${portPrefix}.plugType`, { val: plugType, ack: true });
                await this.setStateAsync(`${portPrefix}.displayPlugType`, { val: displayPlugType, ack: true });
                await this.setStateAsync(`${portPrefix}.lastUpdate`, { val: new Date().toISOString(), ack: true });
            }

            await this.setStateAsync(`${stationPrefix}.lastUpdate`, { val: new Date().toISOString(), ack: true });

            if (notifyEnabled && prev !== undefined && prev !== 'available' && derived === 'available') {
                await this.sendAvailableNotification({
                    city,
                    station: st.name,
                    freePorts,
                    portCount,
                    status: derived,
                });
            }

            this.log.info(`Aktualisiert: ${st.name} → city=${city}, freePorts=${freePorts}, portCount=${portCount}, derived=${derived}`);
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