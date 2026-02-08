'use strict';

const utils = require('@iobroker/adapter-core');
const axios = require('axios');

class CptAdapter extends utils.Adapter {
    constructor(options) {
        super({ ...options, name: 'cpt' });

        this.pollInterval = null;

        this.on('ready', this.onReady.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    makeSafeName(name) {
        return (name || '')
            .toLowerCase()
            .replace(/[^a-z0-9]/g, '_')
            .replace(/_+/g, '_')
            .replace(/^_+|_+$/g, '');
    }

    deriveStationStatusFromPorts(ports) {
        const statuses = (Array.isArray(ports) ? ports : [])
            .map((p) => (p?.statusV2 || p?.status || 'unknown'))
            .map((s) => (typeof s === 'string' ? s.toLowerCase() : 'unknown'));

        if (statuses.some((s) => ['in_use', 'charging', 'occupied'].includes(s))) return 'in_use';
        if (statuses.some((s) => s === 'available')) return 'available';
        if (statuses.some((s) => ['unavailable', 'out_of_service', 'faulted', 'offline'].includes(s))) return 'unavailable';
        return statuses[0] || 'unknown';
    }

    getCityKey(station) {
        const city = (station.city || station.location || station.ort || '').toString().trim();
        return city ? city : 'Unbekannt';
    }

    getStationKey(station) {
        // Prefer name, fallback to deviceId
        const base = station.name ? station.name : `station_${station.deviceId}`;
        return base;
    }

    getStationChannelId(station) {
        const cityKey = this.makeSafeName(this.getCityKey(station)) || 'unbekannt';
        const stationKey = this.makeSafeName(this.getStationKey(station)) || `station_${station.deviceId}`;
        return `stations.${cityKey}.${stationKey}`;
    }

    async ensureCityChannel(cityPrefix, cityName) {
        await this.setObjectNotExistsAsync(cityPrefix, {
            type: 'channel',
            common: { name: cityName },
            native: {},
        });
    }

    async ensureStationObjects(stationPrefix, station) {
        await this.setObjectNotExistsAsync(stationPrefix, {
            type: 'channel',
            common: { name: station.name },
            native: {},
        });

        await this.setObjectNotExistsAsync(`${stationPrefix}.deviceId`, {
            type: 'state',
            common: { name: 'Device ID', type: 'string', role: 'value', read: true, write: false },
            native: {},
        });
        await this.setStateAsync(`${stationPrefix}.deviceId`, { val: String(station.deviceId), ack: true });

        await this.setObjectNotExistsAsync(`${stationPrefix}.enabled`, {
            type: 'state',
            common: { name: 'Aktiv', type: 'boolean', role: 'indicator', read: true, write: false },
            native: {},
        });
        await this.setStateAsync(`${stationPrefix}.enabled`, { val: !!station.enabled, ack: true });

        await this.setObjectNotExistsAsync(`${stationPrefix}.status`, {
            type: 'state',
            common: { name: 'Status (Station)', type: 'string', role: 'value', read: true, write: false },
            native: {},
        });

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

        await this.setObjectNotExistsAsync(`${portPrefix}.status`, {
            type: 'state',
            common: { name: 'Status', type: 'string', role: 'value', read: true, write: false },
            native: {},
        });

        await this.setObjectNotExistsAsync(`${portPrefix}.statusV2`, {
            type: 'state',
            common: { name: 'StatusV2', type: 'string', role: 'value', read: true, write: false },
            native: {},
        });

        await this.setObjectNotExistsAsync(`${portPrefix}.evseId`, {
            type: 'state',
            common: { name: 'EVSE ID', type: 'string', role: 'value', read: true, write: false },
            native: {},
        });

        await this.setObjectNotExistsAsync(`${portPrefix}.maxPowerKw`, {
            type: 'state',
            common: { name: 'Max Power', type: 'number', role: 'value.power', unit: 'kW', read: true, write: false },
            native: {},
        });

        await this.setObjectNotExistsAsync(`${portPrefix}.level`, {
            type: 'state',
            common: { name: 'Level', type: 'string', role: 'text', read: true, write: false },
            native: {},
        });

        await this.setObjectNotExistsAsync(`${portPrefix}.displayLevel`, {
            type: 'state',
            common: { name: 'Display Level', type: 'string', role: 'text', read: true, write: false },
            native: {},
        });

        await this.setObjectNotExistsAsync(`${portPrefix}.plugType`, {
            type: 'state',
            common: { name: 'Plug Type', type: 'string', role: 'text', read: true, write: false },
            native: {},
        });

        await this.setObjectNotExistsAsync(`${portPrefix}.displayPlugType`, {
            type: 'state',
            common: { name: 'Display Plug Type', type: 'string', role: 'text', read: true, write: false },
            native: {},
        });

        await this.setObjectNotExistsAsync(`${portPrefix}.lastUpdate`, {
            type: 'state',
            common: { name: 'Letztes Update', type: 'string', role: 'date', read: true, write: false },
            native: {},
        });

        return portPrefix;
    }

    async cleanupRemovedStations(allowedStationChannels, allowedCityChannels) {
        const startkey = `${this.namespace}.stations.`;
        const endkey = `${this.namespace}.stations.香`;

        const view = await this.getObjectViewAsync('system', 'channel', { startkey, endkey });
        const rows = view?.rows || [];
        this.log.info(`Cleanup: gefundene channels unter stations.*: ${rows.length}`);

        // 1) Delete station channels not in config (supports new and old structure)
        for (const row of rows) {
            const id = row.id;
            const rel = id.substring(`${this.namespace}.`.length); // "stations.x" / "stations.city.station" / ...
            const parts = rel.split('.');

            // New structure station: stations.<city>.<station> (3 parts)
            if (parts.length === 3 && parts[0] === 'stations') {
                if (!allowedStationChannels.has(id)) {
                    this.log.info(`Station nicht mehr in Config → lösche Objekte rekursiv: ${id}`);
                    await this.delObjectAsync(id, { recursive: true });
                }
            }

            // Old structure station: stations.<station> (2 parts) -> delete always (migration), unless still allowed (not possible now)
            if (parts.length === 2 && parts[0] === 'stations') {
                if (!allowedCityChannels.has(id)) { // old station channels won't be in allowed city set
                    this.log.info(`Alte Struktur gefunden → lösche Objekte rekursiv: ${id}`);
                    await this.delObjectAsync(id, { recursive: true });
                }
            }
        }

        // 2) Delete city channels that are no longer used
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

    async onReady() {
        this.log.info('Adapter CPT gestartet');
        this.log.info('Konfiguration (this.config): ' + JSON.stringify(this.config));

        const stationsRaw = this.config.stations || [];
        const intervalMin = Number(this.config.interval) || 5;

        const stations = (Array.isArray(stationsRaw) ? stationsRaw : [])
            .filter((s) => s && typeof s === 'object')
            .map((s, index) => {
                const deviceId = s.deviceId ?? s.stationId ?? s.id;
                const id = s.id || `station${index + 1}`;
                const name = s.name || `station_${deviceId || id}`;
                const enabled = s.enabled !== false;
                const city = (s.city || '').toString();
                return { ...s, id, deviceId, name, enabled, city };
            })
            .filter((s) => {
                if (!s.deviceId) {
                    this.log.warn(`Station "${s.name || s.id}" ohne deviceId – überspringe: ${JSON.stringify(s)}`);
                    return false;
                }
                return true;
            });

        this.log.info(`Anzahl Stationen (gültig): ${stations.length}`);
        this.log.info(`Polling-Intervall: ${intervalMin} Minuten`);

        const allowedStationChannels = new Set(
            stations.map((s) => `${this.namespace}.${this.getStationChannelId(s)}`)
        );
        const allowedCityChannels = new Set(
            stations.map((s) => `${this.namespace}.stations.${this.makeSafeName(this.getCityKey(s)) || 'unbekannt'}`)
        );

        await this.cleanupRemovedStations(allowedStationChannels, allowedCityChannels);

        if (stations.length === 0) {
            this.log.warn('Keine gültigen Stationen in der Konfiguration gefunden');
            return;
        }

        // Create city + station objects
        for (const station of stations) {
            const cityName = this.getCityKey(station);
            const cityKey = this.makeSafeName(cityName) || 'unbekannt';
            const cityPrefix = `stations.${cityKey}`;
            await this.ensureCityChannel(cityPrefix, cityName);

            const stationPrefix = this.getStationChannelId(station);
            await this.ensureStationObjects(stationPrefix, station);

            const initialStatus = station.enabled ? 'initialisiert' : 'deaktiviert';
            await this.setStateAsync(`${stationPrefix}.status`, { val: initialStatus, ack: true });
            await this.setStateAsync(`${stationPrefix}.statusDerived`, { val: initialStatus, ack: true });
            await this.setStateAsync(`${stationPrefix}.freePorts`, { val: 0, ack: true });
            await this.setStateAsync(`${stationPrefix}.lastUpdate`, { val: new Date().toISOString(), ack: true });
        }

        try {
            await this.updateAllStations(stations);
        } catch (e) {
            this.log.error(`Fehler bei initialem Update: ${e?.message || e}`);
        }

        this.pollInterval = setInterval(() => {
            this.updateAllStations(stations).catch((e) => this.log.error(`Polling-Fehler: ${e?.message || e}`));
        }, intervalMin * 60 * 1000);
    }

    async updateAllStations(stations) {
        for (const station of stations) {
            const stationPrefix = this.getStationChannelId(station);

            if (station.enabled === false) {
                await this.setStateAsync(`${stationPrefix}.status`, { val: 'deaktiviert', ack: true });
                await this.setStateAsync(`${stationPrefix}.statusDerived`, { val: 'deaktiviert', ack: true });
                await this.setStateAsync(`${stationPrefix}.freePorts`, { val: 0, ack: true });
                await this.setStateAsync(`${stationPrefix}.lastUpdate`, { val: new Date().toISOString(), ack: true });
                continue;
            }

            try {
                const url = `https://mc.chargepoint.com/map-prod/v3/station/info?deviceId=${station.deviceId}`;
                this.log.debug(`GET ${url}`);

                const res = await axios.get(url, { timeout: 12000 });
                const data = res.data || {};

                const stationStatus = data?.stationStatus || data?.status || 'unknown';
                await this.setStateAsync(`${stationPrefix}.status`, { val: stationStatus, ack: true });

                const portsInfo = data?.portsInfo || {};
                const ports = Array.isArray(portsInfo?.ports) ? portsInfo.ports : [];
                const portCount = Number(portsInfo?.portCount ?? ports.length) || ports.length;
                await this.setStateAsync(`${stationPrefix}.portCount`, { val: portCount, ack: true });

                const freePorts = ports.reduce((acc, p) => {
                    const s = (p?.statusV2 || p?.status || '').toString().toLowerCase();
                    return acc + (s === 'available' ? 1 : 0);
                }, 0);
                await this.setStateAsync(`${stationPrefix}.freePorts`, { val: freePorts, ack: true });

                const derived = this.deriveStationStatusFromPorts(ports);
                await this.setStateAsync(`${stationPrefix}.statusDerived`, { val: derived, ack: true });

                for (let i = 0; i < ports.length; i++) {
                    const port = ports[i] || {};
                    const outletNumber = port.outletNumber ?? port.outlet ?? (i + 1);

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

                this.log.info(`Aktualisiert: ${station.name} → freePorts=${freePorts}, ports=${ports.length}`);
            } catch (err) {
                const msg = err?.message || String(err);
                this.log.error(`Fehler bei ${station.name || station.id}: ${msg}`);
                await this.setStateAsync(`${stationPrefix}.status`, { val: 'Fehler', ack: true });
                await this.setStateAsync(`${stationPrefix}.statusDerived`, { val: 'Fehler', ack: true });
                await this.setStateAsync(`${stationPrefix}.lastUpdate`, { val: new Date().toISOString(), ack: true });
            }
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
