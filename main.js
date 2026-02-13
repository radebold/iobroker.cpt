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

    async safeFetch(deviceId) {
        if (!deviceId) return null;
        const url = `https://mc.chargepoint.com/map-prod/v3/station/info?deviceId=${deviceId}`;
        try {
            this.log.debug(`GET ${url}`);
            const res = await axios.get(url, { timeout: 12000 });
            return res.data;
        } catch (err) {
            this.log.warn(`Fetch fehlgeschlagen (${deviceId}): ${err.message}`);
            return null;
        }
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

    getChannels() {
        const channels = Array.isArray(this.config.channels) ? this.config.channels : [];
        return channels
            .filter((c) => c && c.instance)
            .map((c) => ({
                enabled: this.normalizeBool(c.enabled),
                instance: String(c.instance).trim(),
                user: c.user !== undefined && c.user !== null ? String(c.user).trim() : '',
                label: c.label !== undefined && c.label !== null ? String(c.label).trim() : '',
            }))
            .filter((c) => c.enabled && c.instance)
            .filter((c) => {
                const ok = c.instance.startsWith('telegram.') || c.instance.startsWith('whatsapp-cmb.') || c.instance.startsWith('pushover.');
                if (!ok) this.log.warn(`Kommunikations-Instanz wird ignoriert (nicht erlaubt): ${c.instance}`);
                return ok;
            });
    }
getSubscriptions() {
    const raw = Array.isArray(this.config?.subscriptions) ? this.config.subscriptions : [];
    return raw
        .map((s) => ({
            enabled: this.normalizeBool(s.enabled),
            station: String(s.station || '').trim(),
            recipient: String(s.recipient || '').trim(),
            note: String(s.note || '').trim(),
        }))
        .filter((s) => s.enabled && s.station && s.recipient);
}

getSubscriptionsForStation(stationName) {
    const name = String(stationName || '').trim().toLowerCase();
    if (!name) return [];
    return this.getSubscriptions()
        .filter((s) => s.station.toLowerCase() === name || s.station === '*' )
        .map((s) => s.recipient);
}

getStationNameFromPrefix(stationPrefix) {
    const entries = Object.entries(this.stationPrefixByName || {});
    for (const [name, prefix] of entries) {
        if (prefix === stationPrefix) return name;
    }
    return null;
}



    async sendMessageToChannels(text, options = {}) {
    const { recipients = null, isTest = false } = options;

    const channels = this.getChannels();
    const activeChannels = channels.filter((c) => c.enabled && c.instance);

    if (activeChannels.length === 0) {
        this.log.debug('Keine Kommunikationskanäle konfiguriert – Versand übersprungen');
        return;
    }

    // If recipients is provided: filter by label (recipient name)
    const targets = Array.isArray(recipients) && recipients.length
        ? activeChannels.filter((c) => recipients.includes(String(c.label || '').trim()))
        : activeChannels;

    if (targets.length === 0) {
        this.log.debug('Keine passenden Kommunikationskanäle für Empfänger-Auswahl gefunden – Versand übersprungen');
        return;
    }

    for (const ch of targets) {
        const inst = String(ch.instance || '').trim();
        const adapter = inst.split('.')[0];

        try {
            if (adapter === 'telegram') {
                // user can be alias or empty. If empty -> telegram adapter sends to default receiver (if configured)
                const payload = { text };
                if (ch.user) payload.user = ch.user;
                await this.sendToAsync(inst, 'send', payload);
            } else if (adapter === 'whatsapp-cmb' || adapter === 'open-wa') {
                // phone number in ch.user
                const payload = { text };
                if (ch.user) payload.phone = ch.user;
                await this.sendToAsync(inst, 'send', payload);
            } else if (adapter === 'pushover') {
                // pushover adapter typically ignores "user" here and uses its own config
                const payload = { message: text, sound: '' };
                await this.sendToAsync(inst, 'send', payload);
            } else {
                // Fallback: generic send
                await this.sendToAsync(inst, 'send', { text, user: ch.user || undefined });
            }

            this.log.info(`Notify ${isTest ? 'TEST ' : ''}gesendet via ${inst}${ch.label ? ` → ${ch.label}` : ''}`);
        } catch (e) {
            this.log.warn(`Notify fehlgeschlagen via ${inst}${ch.label ? ` (${ch.label})` : ''}: ${e.message}`);
        }
    }
}

async sendAvailableNotification({ city, station, freePorts, portCount, status, isTest = false, recipients = null }) {
    const stationText = station ? String(station) : 'Unbekannte Station';
    const cityText = city ? String(city) : '';
    const location = cityText ? `${cityText} – ${stationText}` : stationText;

    // Standard-Text
    const text = `Ladestation ${location} ist nun frei (${freePorts}/${portCount})`;

    await this.sendMessageToChannels(text, { recipients, isTest });
}

async sendTestNotifyForPrefix(stationPrefix) {
    try {
        const stationName = this.getStationNameFromPrefix(stationPrefix) || stationPrefix.split('.').slice(-1)[0];
        const cityKey = stationPrefix.split('.')[1] || '';
        const city = await this.getStateAsync(`${stationPrefix}.city`).then(s => s?.val).catch(() => null);

        const freePorts = await this.getStateAsync(`${stationPrefix}.freePorts`).then(s => s?.val).catch(() => 1);
        const portCount = await this.getStateAsync(`${stationPrefix}.portCount`).then(s => s?.val).catch(() => 1);
        const recipients = this.getSubscriptionsForStation(stationName);

        await this.sendAvailableNotification({
            city: city || cityKey,
            station: stationName,
            freePorts: Number(freePorts) || 1,
            portCount: Number(portCount) || 1,
            status: 'available',
            isTest: true,
            recipients: recipients.length ? recipients : null, // if no subscriptions -> send to all channels
        });

        this.log.info(`TEST Notify ausgelöst: ${stationName} (${city || cityKey || 'n/a'})`);
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
            
        if (obj.command === 'testStation') {
            const name = (obj.message?.name || '').toString().trim();
            if (!name) {
                obj.callback && this.sendTo(obj.from, obj.command, { error: 'Kein Stations-Name gesetzt' }, obj.callback);
                return;
            }

            try {
                let stationPrefix = this.stationPrefixByName[name];

                // Fallback: search by stored states if not in map yet
                if (!stationPrefix) {
                    const nameStates = await this.getStatesAsync(this.namespace + '.stations.*.*.name');
                    for (const [id, st] of Object.entries(nameStates || {})) {
                        if (st && st.val && String(st.val) === name) {
                            stationPrefix = id.replace(this.namespace + '.', '').replace(/\.name$/, '');
                            break;
                        }
                    }
                }

                if (!stationPrefix) {
                    throw new Error('Station nicht gefunden (noch keine Daten vom Polling?)');
                }

                await this.sendTestNotifyForPrefix(stationPrefix);

                obj.callback && this.sendTo(
                    obj.from,
                    obj.command,
                    { data: { result: `Test für ${name} gesendet` } },
                    obj.callback
                );
            } catch (e) {
                obj.callback && this.sendTo(obj.from, obj.command, { error: e.message }, obj.callback);
            }
            return;
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
            this.stationPrefixByName[st.name] = stationPrefix;
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
    const subs = this.getSubscriptionsForStation(stationName);
    const hasSubs = subs.length > 0;

    // Trigger if station was previously fully occupied (freePorts==0) and now has at least one free port
    const becameFree = oldFreePorts !== undefined && Number(oldFreePorts) === 0 && Number(freePorts) > 0;

    if (hasSubs && becameFree) {
        await this.sendAvailableNotification({
            city,
            station: stationName,
            freePorts,
            portCount,
            status: derived,
            isTest: false,
            recipients: subs,
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