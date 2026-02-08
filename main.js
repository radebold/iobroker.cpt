'use strict';

const utils = require('@iobroker/adapter-core');
const axios = require('axios');

class CptAdapter extends utils.Adapter {
    constructor(options) {
        super({ ...options, name: 'cpt' });

        this.pollInterval = null;

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

    fillPlaceholders(str, ctx) {
        return (str || '').replace(/\{\{(\w+)\}\}/g, (_, key) => {
            const v = ctx[key];
            return v === undefined || v === null ? '' : String(v);
        });
    }

    async ensureCityChannel(cityPrefix, cityName) {
        await this.setObjectNotExistsAsync(cityPrefix, {
            type: 'channel',
            common: { name: cityName },
            native: {},
        });
    }

    async ensureToolsObjects() {
        await this.setObjectNotExistsAsync('tools', {
            type: 'channel',
            common: { name: 'Tools' },
            native: {},
        });

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

        await this.setStateAsync('tools.export', { val: false, ack: true });
    }

    async ensureStationObjects(stationPrefix, station) {
        await this.setObjectNotExistsAsync(stationPrefix, {
            type: 'channel',
            common: { name: station.name },
            native: {},
        });

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

        // Notify flag as writable object (per station)
        await this.setObjectNotExistsAsync(`${stationPrefix}.notifyOnAvailable`, {
            type: 'state',
            common: { name: 'Benachrichtigen wenn verfügbar', type: 'boolean', role: 'switch', read: true, write: true, def: false },
            native: {},
        });
        // Only set default once (do not overwrite user's choice)
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

        await this.setObjectNotExistsAsync(`${stationPrefix}.ports`, {
            type: 'channel',
            common: { name: 'Ports' },
            native: {},
        });
    }

    async ensurePortObjects(stationPrefix, outletNumber) {
        const portPrefix = `${stationPrefix}.ports.${outletNumber}`;

        await this.setObjectNotExistsAsync(portPrefix, {
            type: 'channel',
            common: { name: `Port ${outletNumber}` },
            native: {},
        });

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
            await this.setObjectNotExistsAsync(`${portPrefix}.${id}`, {
                type: 'state',
                common: { read: true, write: false, ...common },
                native: {},
            });
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

            // stations.<city>.<station>
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
            // stations.<city>
            if (parts.length === 2 && parts[0] === 'stations') {
                if (!allowedCityChannels.has(id)) {
                    this.log.info(`Ort nicht mehr in Config → lösche Channel rekursiv: ${id}`);
                    await this.delObjectAsync(id, { recursive: true });
                }
            }
        }
    }

    async onReady() {
        this.log.info('Adapter CPT gestartet');
        this.log.info('Konfiguration: ' + JSON.stringify(this.config));

        await this.ensureToolsObjects();
        this.subscribeStates('tools.export');

        // subscribe to all per-station notify flags
        this.subscribeStates('stations.*.*.notifyOnAvailable');

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

        // Initial fetch to know cities for cleanup + create base objects
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

        if (id === `${this.namespace}.tools.export` && state.val === true) {
            await this.doExportStations();
            await this.setStateAsync('tools.export', { val: false, ack: true });
        }

        // notifyOnAvailable is writable; no action needed, adapter reads it on transitions
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
            this.log.warn(`Konnte Export-Datei nicht schreiben: ${e?.message || e}`);
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
            this.log.warn(`Fetch fehlgeschlagen für deviceId=${deviceId}: ${e?.message || e}`);
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

    async sendAvailableNotification(ctx) {
        const channels = Array.isArray(this.config.channels) ? this.config.channels : [];
        const enabledChannels = channels.filter((c) => c && c.enabled !== false && c.instance);

        if (enabledChannels.length === 0) {
            this.log.debug(`Keine Kommunikationskanäle konfiguriert – Notification übersprungen für ${ctx.station}`);
            return;
        }

        for (const ch of enabledChannels) {
            const instance = String(ch.instance).trim();
            const command = (ch.command ? String(ch.command) : 'send').trim();

            let payloadRaw = ch.payload ? String(ch.payload) : '{"text":"{{text}}"}';
            payloadRaw = this.fillPlaceholders(payloadRaw, ctx);

            let payloadObj = null;
            try {
                payloadObj = JSON.parse(payloadRaw);
            } catch (e) {
                this.log.warn(`Channel payload ist kein gültiges JSON (${instance}): ${e.message}`);
                continue;
            }

            try {
                // sendTo can accept (instance, command, msg)
                this.sendTo(instance, command, payloadObj);
                this.log.info(`Notification gesendet über ${instance}/${command} für ${ctx.city} / ${ctx.station}`);
            } catch (e) {
                this.log.warn(`sendTo fehlgeschlagen (${instance}/${command}): ${e.message}`);
            }
        }
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

            // Read current notify flag (state, not config)
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

            // Detect transition to available (use existing state to persist across restarts)
            const prevState = await this.getStateAsync(`${stationPrefix}.statusDerived`);
            const prev = prevState?.val ? String(prevState.val) : undefined;

            await this.setStateAsync(`${stationPrefix}.portCount`, { val: portCount, ack: true });
            await this.setStateAsync(`${stationPrefix}.freePorts`, { val: freePorts, ack: true });
            await this.setStateAsync(`${stationPrefix}.statusDerived`, { val: derived, ack: true });

            // Update ports
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
                if (maxPowerKw !== null) {
                    await this.setStateAsync(`${portPrefix}.maxPowerKw`, { val: maxPowerKw, ack: true });
                }
                await this.setStateAsync(`${portPrefix}.level`, { val: level, ack: true });
                await this.setStateAsync(`${portPrefix}.displayLevel`, { val: displayLevel, ack: true });
                await this.setStateAsync(`${portPrefix}.plugType`, { val: plugType, ack: true });
                await this.setStateAsync(`${portPrefix}.displayPlugType`, { val: displayPlugType, ack: true });
                await this.setStateAsync(`${portPrefix}.lastUpdate`, { val: new Date().toISOString(), ack: true });
            }

            await this.setStateAsync(`${stationPrefix}.lastUpdate`, { val: new Date().toISOString(), ack: true });

            // Notification: only on transition
            if (notifyEnabled && prev !== undefined && prev !== 'available' && derived === 'available') {
                const text = `🔌 Ladestation verfügbar\n\nOrt: ${city}\nStation: ${st.name}\nFreie Ports: ${freePorts} von ${portCount}`;
                await this.sendAvailableNotification({
                    text,
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
