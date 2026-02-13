'use strict';

const utils = require('@iobroker/adapter-core');
const axios = require('axios');

function isTrue(v) {
    return v === true || v === 'true' || v === 1 || v === '1' || v === 'on' || v === 'yes';
}

class CptAdapter extends utils.Adapter {
    constructor(options) {
        super({ ...options, name: 'cpt' });

        this.pollInterval = null;

        // transition detection (per stationPrefix)
        this.lastFreePortsByStation = {};
        this.stationPrefixByName = {};

        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('message', this.onMessage.bind(this));
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
        const base = station?.name ? station.name : `station_${station?.deviceId1}`;
        return this.makeSafeName(base) || `station_${station?.deviceId1}`;
    }

    extractGps(data1, data2) {
        const cand = [data1, data2].filter(Boolean);
        for (const d of cand) {
            const lat = d?.latitude ?? d?.lat ?? d?.location?.latitude ?? d?.location?.lat ?? d?.position?.latitude ?? d?.position?.lat;
            const lon =
                d?.longitude ??
                d?.lng ??
                d?.lon ??
                d?.location?.longitude ??
                d?.location?.lng ??
                d?.location?.lon ??
                d?.position?.longitude ??
                d?.position?.lng ??
                d?.position?.lon;

            if (typeof lat === 'number' && typeof lon === 'number') return { lat, lon };
            const latN = lat !== undefined ? Number(lat) : NaN;
            const lonN = lon !== undefined ? Number(lon) : NaN;
            if (!Number.isNaN(latN) && !Number.isNaN(lonN)) return { lat: latN, lon: lonN };
        }
        return null;
    }

    async updateStateIfChanged(id, val, ack = true) {
        const cur = await this.getStateAsync(id).catch(() => null);
        const curVal = cur ? cur.val : undefined;
        if (cur === null || cur === undefined || curVal !== val) {
            await this.setStateAsync(id, { val, ack });
            return true;
        }
        return false;
    }

    // ---------- Admin / Config helpers ----------

    getActiveChannels(ctx = {}) {
        let channels = this.config.channels || [];

        if (channels && !Array.isArray(channels) && typeof channels === 'object') {
            channels = Object.values(channels);
        }
        if (typeof channels === 'string') {
            try {
                channels = JSON.parse(channels);
            } catch {
                channels = [];
            }
        }
        if (!Array.isArray(channels)) channels = [];

        let active = channels.filter((c) => c && isTrue(c.enabled) && c.instance);
        active = active
            .map((c) => ({
                instance: String(c.instance).trim(),
                user: c.user !== undefined && c.user !== null ? String(c.user).trim() : '',
                label: c.label !== undefined && c.label !== null ? String(c.label).trim() : '',
            }))
            .filter((c) => {
                const ok = c.instance.startsWith('telegram.') || c.instance.startsWith('whatsapp-cmb.') || c.instance.startsWith('pushover.');
                if (!ok) this.log.warn(`Kommunikations-Instanz wird ignoriert (nicht erlaubt): ${c.instance}`);
                return ok;
            });

        if (ctx.onlyInstance) active = active.filter((c) => c.instance === String(ctx.onlyInstance));
        if (ctx.onlyLabel) active = active.filter((c) => (c.label || '').toLowerCase() === String(ctx.onlyLabel).toLowerCase());
        return active;
    }

    getSubscriptions() {
        let subs = this.config.subscriptions || [];
        if (subs && !Array.isArray(subs) && typeof subs === 'object') subs = Object.values(subs);
        if (typeof subs === 'string') {
            try {
                subs = JSON.parse(subs);
            } catch {
                subs = [];
            }
        }
        if (!Array.isArray(subs)) subs = [];
        return subs;
    }

    // ---------- Messaging ----------

    async sendMessageToChannels(text, ctx = {}) {
        const channels = this.getActiveChannels(ctx);
        if (!channels.length) {
            this.log.debug('Keine Kommunikationskanäle konfiguriert – Versand übersprungen');
            return { ok: 0, failed: 0, note: 'no_channels' };
        }

        let ok = 0;
        let failed = 0;

        for (const ch of channels) {
            const inst = ch.instance;
            const u = ch.user;
            const lbl = ch.label;

            const isTelegram = inst.startsWith('telegram.');
            const isWhatsAppCmb = inst.startsWith('whatsapp-cmb.');
            const isPushover = inst.startsWith('pushover.');

            let payload;
            if (isTelegram) {
                payload = { text, ...(u ? { user: u } : {}) };
            } else if (isWhatsAppCmb) {
                payload = {
                    phone: u || undefined,
                    number: u || undefined,
                    to: u || undefined,
                    text,
                    message: text,
                    title: 'ChargePoint',
                    channelLabel: lbl || undefined,
                };
            } else if (isPushover) {
                payload = { message: text, sound: '' };
            } else {
                payload = { text };
            }

            if (ctx.city && payload.city === undefined) payload.city = ctx.city;
            if (ctx.station && payload.station === undefined) payload.station = ctx.station;
            if (ctx.status && payload.status === undefined) payload.status = ctx.status;
            if (ctx.freePorts !== undefined && payload.freePorts === undefined) payload.freePorts = ctx.freePorts;
            if (ctx.portCount !== undefined && payload.portCount === undefined) payload.portCount = ctx.portCount;

            Object.keys(payload).forEach((k) => payload[k] === undefined && delete payload[k]);

            try {
                this.sendTo(inst, 'send', payload);
                ok++;
                this.log.info(`Message gesendet über ${inst}${lbl ? ' (' + lbl + ')' : ''}`);
            } catch (e) {
                failed++;
                this.log.warn(`sendTo fehlgeschlagen (${inst}): ${e.message}`);
            }
        }

        return { ok, failed, note: 'sent' };
    }

    async sendAvailableNotification(ctx) {
        const prefix = ctx.isTest ? 'TEST: ' : '';
        const details = ctx.freePorts !== undefined && ctx.portCount !== undefined ? ` (${ctx.freePorts}/${ctx.portCount})` : '';
        const text = `${prefix}Ladestation ${ctx.station} in ${ctx.city} ist nun frei${details}`;
        return this.sendMessageToChannels(text, ctx);
    }

    async notifySubscribers({ stationPrefixRel, city, stationName, freePorts, portCount, isTest = false }) {
        const subs = this.getSubscriptions();
        const matches = subs.filter((s) => s && isTrue(s.enabled) && String(s.station) === String(stationPrefixRel));

        // If no subscriptions exist, fall back to “all active channels” (keeps old behaviour)
        if (!matches.length) {
            return this.sendAvailableNotification({ isTest, station: stationName, city, freePorts, portCount });
        }

        for (const s of matches) {
            const recipientLabel = (s.recipient || '').toString().trim();
            if (!recipientLabel) continue;
            await this.sendAvailableNotification({
                isTest,
                station: stationName,
                city,
                freePorts,
                portCount,
                onlyLabel: recipientLabel,
            });
        }
        return { ok: matches.length, failed: 0, note: 'subscriptions' };
    }

    async sendTestNotifyForPrefix(stationPrefixRel) {
        const nameState = await this.getStateAsync(`${stationPrefixRel}.name`).catch(() => null);
        const cityState = await this.getStateAsync(`${stationPrefixRel}.city`).catch(() => null);
        const freePortsState = await this.getStateAsync(`${stationPrefixRel}.freePorts`).catch(() => null);
        const portCountState = await this.getStateAsync(`${stationPrefixRel}.portCount`).catch(() => null);

        const station = nameState?.val ? String(nameState.val) : stationPrefixRel.split('.').pop();
        const city = cityState?.val ? String(cityState.val) : stationPrefixRel.split('.')[1];
        const freePorts = freePortsState?.val !== undefined ? Number(freePortsState.val) : undefined;
        const portCount = portCountState?.val !== undefined ? Number(portCountState.val) : undefined;

        await this.notifySubscribers({ stationPrefixRel, city, stationName: station, freePorts, portCount, isTest: true });
    }

    // ---------- Objects ----------

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
        await this.setStateAsync('tools.testNotifyAll', { val: false, ack: true });
    }

    async ensureStationObjects(stationPrefix, station, cityName) {
        await this.setObjectNotExistsAsync(stationPrefix, { type: 'channel', common: { name: station.name }, native: {} });

        const states = [
            ['name', { name: 'Name', type: 'string', role: 'text', read: true, write: false }],
            ['city', { name: 'Ort', type: 'string', role: 'text', read: true, write: false }],
            ['deviceId1', { name: 'Device ID (P1)', type: 'string', role: 'value', read: true, write: false }],
            ['deviceId2', { name: 'Device ID (P2)', type: 'string', role: 'value', read: true, write: false }],
            ['enabled', { name: 'Aktiv', type: 'boolean', role: 'indicator', read: true, write: false }],
            ['notifyOnAvailable', { name: 'Benachrichtigen wenn verfügbar', type: 'boolean', role: 'switch', read: true, write: true, def: false }],
            ['testNotify', { name: 'Test: Notify (Button)', type: 'boolean', role: 'button', read: true, write: true, def: false }],
            ['statusDerived', { name: 'Status (aus Ports)', type: 'string', role: 'value', read: true, write: false }],
            ['portCount', { name: 'Anzahl Ports', type: 'number', role: 'value', read: true, write: false }],
            ['freePorts', { name: 'Freie Ports', type: 'number', role: 'value', read: true, write: false }],
            ['lastUpdate', { name: 'Letztes Update', type: 'string', role: 'date', read: true, write: false }],
        ];

        for (const [id, common] of states) {
            await this.setObjectNotExistsAsync(`${stationPrefix}.${id}`, { type: 'state', common, native: {} });
        }

        await this.setObjectNotExistsAsync(`${stationPrefix}.gps`, { type: 'channel', common: { name: 'GPS' }, native: {} });
        await this.setObjectNotExistsAsync(`${stationPrefix}.gps.lat`, {
            type: 'state',
            common: { name: 'Latitude', type: 'number', role: 'value.gps.latitude', read: true, write: false },
            native: {},
        });
        await this.setObjectNotExistsAsync(`${stationPrefix}.gps.lon`, {
            type: 'state',
            common: { name: 'Longitude', type: 'number', role: 'value.gps.longitude', read: true, write: false },
            native: {},
        });
        await this.setObjectNotExistsAsync(`${stationPrefix}.gps.json`, {
            type: 'state',
            common: { name: 'GPS (JSON)', type: 'string', role: 'json', read: true, write: false },
            native: {},
        });

        await this.setObjectNotExistsAsync(`${stationPrefix}.ports`, { type: 'channel', common: { name: 'Ports' }, native: {} });

        await this.setStateAsync(`${stationPrefix}.name`, { val: String(station.name || ''), ack: true });
        await this.setStateAsync(`${stationPrefix}.city`, { val: String(cityName || ''), ack: true });
        await this.setStateAsync(`${stationPrefix}.deviceId1`, { val: String(station.deviceId1 ?? ''), ack: true });
        await this.setStateAsync(`${stationPrefix}.deviceId2`, { val: station.deviceId2 ? String(station.deviceId2) : '', ack: true });
        await this.setStateAsync(`${stationPrefix}.enabled`, { val: !!station.enabled, ack: true });

        const curNotify = await this.getStateAsync(`${stationPrefix}.notifyOnAvailable`).catch(() => null);
        if (!curNotify || curNotify.val === null || curNotify.val === undefined) {
            await this.setStateAsync(`${stationPrefix}.notifyOnAvailable`, { val: !!station.notifyOnAvailable, ack: true });
        }
    }

    async ensurePortObjects(stationPrefix, outletNumber) {
        const portPrefix = `${stationPrefix}.ports.${outletNumber}`;
        await this.setObjectNotExistsAsync(portPrefix, { type: 'channel', common: { name: `Port ${outletNumber}` }, native: {} });

        const states = [
            ['status', { name: 'Status', type: 'string', role: 'value' }],
            ['statusV2', { name: 'StatusV2', type: 'string', role: 'value' }],
            ['evseId', { name: 'EVSE ID', type: 'string', role: 'value' }],
            ['maxPowerKw', { name: 'Max Power', type: 'number', role: 'value.power', unit: 'kW' }],
            ['displayPlugType', { name: 'Plug', type: 'string', role: 'text' }],
            ['lastUpdate', { name: 'Letztes Update', type: 'string', role: 'date' }],
        ];

        for (const [id, common] of states) {
            await this.setObjectNotExistsAsync(`${portPrefix}.${id}`, { type: 'state', common: { read: true, write: false, ...common }, native: {} });
        }

        return portPrefix;
    }

    // ---------- ChargePoint API ----------

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
            const p1 = data1?.portsInfo?.ports?.[0] || {};
            const p2 = data2?.portsInfo?.ports?.[0] || {};
            return [{ ...p1, outletNumber: 1 }, { ...p2, outletNumber: 2 }];
        }
        return Array.isArray(data1?.portsInfo?.ports) ? data1.portsInfo.ports : [];
    }

    async updateAllStations(stations) {
        for (const st of stations) {
            const data1 = await this.safeFetch(st.deviceId1);
            const data2 = st.deviceId2 ? await this.safeFetch(st.deviceId2) : null;

            const city = this.pickCity(data1, data2);
            const cityKey = this.makeSafeName(city) || 'unbekannt';
            const stationKey = this.getStationKey(st);
            const stationPrefix = `stations.${cityKey}.${stationKey}`;

            this.stationPrefixByName[st.name] = stationPrefix;

            await this.ensureCityChannel(`stations.${cityKey}`, city);
            await this.ensureStationObjects(stationPrefix, st, city);

            const gps = this.extractGps(data1, data2);
            if (gps) {
                await this.updateStateIfChanged(`${stationPrefix}.gps.lat`, gps.lat);
                await this.updateStateIfChanged(`${stationPrefix}.gps.lon`, gps.lon);
                await this.updateStateIfChanged(`${stationPrefix}.gps.json`, JSON.stringify(gps));
            }

            if (st.enabled === false) {
                await this.updateStateIfChanged(`${stationPrefix}.statusDerived`, 'deaktiviert');
                await this.updateStateIfChanged(`${stationPrefix}.portCount`, 0);
                await this.updateStateIfChanged(`${stationPrefix}.freePorts`, 0);
                await this.setStateAsync(`${stationPrefix}.lastUpdate`, { val: new Date().toISOString(), ack: true });
                continue;
            }

            const ports = this.buildLogicalPorts(data1, data2, !!st.deviceId2);
            const portCount = st.deviceId2 ? 2 : ports.length;
            const freePorts = ports.reduce((acc, p) => acc + (this.normalizeStatus(p?.statusV2 || p?.status) === 'available' ? 1 : 0), 0);
            const derived = this.deriveStationStatusFromPorts(ports);

            const prevFree = this.lastFreePortsByStation[stationPrefix];

            await this.updateStateIfChanged(`${stationPrefix}.portCount`, portCount);
            await this.updateStateIfChanged(`${stationPrefix}.freePorts`, freePorts);
            await this.updateStateIfChanged(`${stationPrefix}.statusDerived`, derived);
            await this.setStateAsync(`${stationPrefix}.lastUpdate`, { val: new Date().toISOString(), ack: true });

            // ports
            for (let i = 0; i < ports.length; i++) {
                const port = ports[i] || {};
                const outletNumber = port.outletNumber ?? i + 1;
                const portPrefix = await this.ensurePortObjects(stationPrefix, outletNumber);

                const connector0 = Array.isArray(port.connectorList) && port.connectorList.length ? port.connectorList[0] : null;
                const displayPlugType = connector0?.displayPlugType ? String(connector0.displayPlugType) : '';

                await this.updateStateIfChanged(`${portPrefix}.status`, port.status || 'unknown');
                await this.updateStateIfChanged(`${portPrefix}.statusV2`, port.statusV2 || 'unknown');
                await this.updateStateIfChanged(`${portPrefix}.evseId`, port.evseId ? String(port.evseId) : '');

                const prMax = port?.powerRange?.max;
                const maxPowerKw = typeof prMax === 'number' ? prMax : prMax !== undefined ? Number(prMax) : NaN;
                if (!Number.isNaN(maxPowerKw)) await this.updateStateIfChanged(`${portPrefix}.maxPowerKw`, maxPowerKw);

                await this.updateStateIfChanged(`${portPrefix}.displayPlugType`, displayPlugType);
                await this.setStateAsync(`${portPrefix}.lastUpdate`, { val: new Date().toISOString(), ack: true });
            }

            // notify on 0 -> >0
            if (prevFree !== undefined && Number(prevFree) === 0 && Number(freePorts) > 0) {
                const notifyState = await this.getStateAsync(`${stationPrefix}.notifyOnAvailable`).catch(() => null);
                const notifyEnabled = notifyState?.val === true;

                // If any subscription exists for station, we notify regardless of station toggle
                const subs = this.getSubscriptions();
                const hasSubs = subs.some((s) => s && isTrue(s.enabled) && String(s.station) === String(stationPrefix));

                if (notifyEnabled || hasSubs) {
                    await this.notifySubscribers({
                        stationPrefixRel: stationPrefix,
                        city,
                        stationName: st.name,
                        freePorts,
                        portCount,
                        isTest: false,
                    });
                    this.log.info(`Notify: ${st.name} (${city}) freePorts ${prevFree} -> ${freePorts}`);
                }
            }
            this.lastFreePortsByStation[stationPrefix] = freePorts;

            this.log.debug(`Aktualisiert: ${st.name} city=${city} freePorts=${freePorts}/${portCount} derived=${derived}`);
        }
    }

    // ---------- ioBroker lifecycle ----------

    async onReady() {
        this.log.info('Adapter CPT gestartet');

        await this.ensureToolsObjects();

        this.subscribeStates('tools.export');
        this.subscribeStates('tools.testNotify');
        this.subscribeStates('tools.testNotifyAll');
        this.subscribeStates('stations.*.*.notifyOnAvailable');
        this.subscribeStates('stations.*.*.testNotify');

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

        if (!stations.length) {
            this.log.warn('Keine gültigen Stationen konfiguriert');
            return;
        }

        // create tree based on current city names
        for (const st of stations) {
            const data1 = await this.safeFetch(st.deviceId1);
            const data2 = st.deviceId2 ? await this.safeFetch(st.deviceId2) : null;
            const city = this.pickCity(data1, data2);
            const cityKey = this.makeSafeName(city) || 'unbekannt';
            const stationKey = this.getStationKey(st);
            const stationPrefix = `stations.${cityKey}.${stationKey}`;
            this.stationPrefixByName[st.name] = stationPrefix;
            await this.ensureCityChannel(`stations.${cityKey}`, city);
            await this.ensureStationObjects(stationPrefix, st, city);
        }

        await this.updateAllStations(stations);

        this.pollInterval = setInterval(() => {
            this.updateAllStations(stations).catch((e) => this.log.error(`Polling-Fehler: ${e?.message || e}`));
        }, intervalMin * 60 * 1000);

        this.log.info(`Polling-Intervall: ${intervalMin} Minuten, Stationen: ${stations.length}`);
    }

    async onStateChange(id, state) {
        if (!state || state.ack) return;

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

        if (id === `${this.namespace}.tools.testNotifyAll` && state.val === true) {
            try {
                const notifStates = await this.getStatesAsync(this.namespace + '.stations.*.*.notifyOnAvailable');
                const prefixes = Object.keys(notifStates || {})
                    .filter((k) => notifStates[k]?.val === true)
                    .map((k) => k.replace(this.namespace + '.', '').replace(/\.notifyOnAvailable$/, ''))
                    .sort();

                for (const p of prefixes) {
                    await this.sendTestNotifyForPrefix(p);
                }
                this.log.info(`TEST Notify ALL: ${prefixes.length} Station(en) ausgelöst`);
            } catch (e) {
                this.log.warn(`TEST Notify ALL fehlgeschlagen: ${e.message}`);
            } finally {
                await this.setStateAsync('tools.testNotifyAll', { val: false, ack: true });
            }
            return;
        }

        const mTest = id.match(new RegExp('^' + this.namespace.replace(/\./g, '\\.') + '\\.stations\\.(.+?)\\.(.+?)\\.testNotify$'));
        if (mTest && state.val === true) {
            const stationPrefixRel = `stations.${mTest[1]}.${mTest[2]}`;
            try {
                await this.sendTestNotifyForPrefix(stationPrefixRel);
            } catch (e) {
                this.log.warn(`TEST Notify fehlgeschlagen für ${stationPrefixRel}: ${e.message}`);
            } finally {
                await this.setStateAsync(`${stationPrefixRel}.testNotify`, { val: false, ack: true });
            }
        }
    }

    async onMessage(obj) {
        if (!obj) return;

        // dropdown for Abos -> station
        if (obj.command === 'getStations') {
            try {
                const list = await this.getStatesAsync(this.namespace + '.stations.*.*.name');
                const opts = [];
                for (const [id, st] of Object.entries(list || {})) {
                    const rel = id.replace(this.namespace + '.', '').replace(/\.name$/, '');
                    const parts = rel.split('.');
                    const city = parts.length >= 3 ? parts[1] : '';
                    const stationName = st?.val ? String(st.val) : parts[2];
                    opts.push({ value: rel, label: `${city} / ${stationName}` });
                }
                obj.callback && this.sendTo(obj.from, obj.command, { options: opts }, obj.callback);
            } catch {
                obj.callback && this.sendTo(obj.from, obj.command, { options: [] }, obj.callback);
            }
            return;
        }

        // dropdown for Abos -> recipient labels
        if (obj.command === 'getRecipients') {
            const active = this.getActiveChannels();
            const labels = new Set();
            for (const ch of active) {
                if (ch.label) labels.add(String(ch.label));
            }
            const opts = Array.from(labels).sort().map((l) => ({ value: l, label: l }));
            obj.callback && this.sendTo(obj.from, obj.command, { options: opts }, obj.callback);
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
                const isTelegram = instance.startsWith('telegram.');
                const isWhatsAppCmb = instance.startsWith('whatsapp-cmb.');
                const isPushover = instance.startsWith('pushover.');

                let payload;
                if (isTelegram) {
                    payload = { text: 'CPT Test: Kommunikation OK ✅', ...(user ? { user } : {}) };
                } else if (isWhatsAppCmb) {
                    payload = {
                        phone: user || undefined,
                        number: user || undefined,
                        to: user || undefined,
                        text: 'CPT Test: Kommunikation OK ✅',
                        message: 'CPT Test: Kommunikation OK ✅',
                        title: 'ChargePoint',
                        channelLabel: label || undefined,
                    };
                } else if (isPushover) {
                    payload = { message: 'CPT Test: Kommunikation OK ✅', sound: '' };
                } else {
                    payload = { text: 'CPT Test: Kommunikation OK ✅' };
                }
                Object.keys(payload).forEach((k) => payload[k] === undefined && delete payload[k]);

                this.sendTo(instance, 'send', payload);
                obj.callback && this.sendTo(obj.from, obj.command, { data: { result: `Test an ${instance} gesendet${user ? ' (' + user + ')' : ''}` } }, obj.callback);
            } catch (e) {
                obj.callback && this.sendTo(obj.from, obj.command, { error: e.message }, obj.callback);
            }
            return;
        }

        if (obj.command === 'testStation') {
            const name = (obj.message?.name || '').toString().trim();
            if (!name) {
                obj.callback && this.sendTo(obj.from, obj.command, { error: 'Kein Stations-Name gesetzt' }, obj.callback);
                return;
            }
            try {
                let stationPrefixRel = this.stationPrefixByName[name];
                if (!stationPrefixRel) {
                    const nameStates = await this.getStatesAsync(this.namespace + '.stations.*.*.name');
                    for (const [id, st] of Object.entries(nameStates || {})) {
                        if (st?.val && String(st.val) === name) {
                            stationPrefixRel = id.replace(this.namespace + '.', '').replace(/\.name$/, '');
                            break;
                        }
                    }
                }
                if (!stationPrefixRel) throw new Error('Station nicht gefunden (noch keine Daten vom Polling?)');

                await this.sendTestNotifyForPrefix(stationPrefixRel);
                obj.callback && this.sendTo(obj.from, obj.command, { data: { result: `Test für ${name} gesendet` } }, obj.callback);
            } catch (e) {
                obj.callback && this.sendTo(obj.from, obj.command, { error: e.message }, obj.callback);
            }
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
            channels: Array.isArray(this.config.channels) ? this.config.channels : this.config.channels || [],
            subscriptions: this.getSubscriptions(),
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

    onUnload(callback) {
        try {
            if (this.pollInterval) clearInterval(this.pollInterval);
            callback();
        } catch {
            callback();
        }
    }
}

if (require.main !== module) {
    module.exports = (options) => new CptAdapter(options);
} else {
    new CptAdapter();
}
