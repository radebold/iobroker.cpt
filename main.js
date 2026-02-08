'use strict';

const utils = require('@iobroker/adapter-core');
const axios = require('axios');

class CptAdapter extends utils.Adapter {
    constructor(options) {
        super({
            ...options,
            name: 'cpt',
        });

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

        // Heuristik: "in_use/charging" schlägt "available" schlägt Rest
        if (statuses.some((s) => ['in_use', 'charging', 'occupied'].includes(s))) return 'in_use';
        if (statuses.some((s) => s === 'available')) return 'available';
        if (statuses.some((s) => ['unavailable', 'out_of_service', 'faulted', 'offline'].includes(s))) return 'unavailable';
        return statuses[0] || 'unknown';
    }

    async ensureStationObjects(prefix, station) {
        await this.setObjectNotExistsAsync(prefix, {
            type: 'channel',
            common: { name: station.name },
            native: {},
        });

        await this.setObjectNotExistsAsync(`${prefix}.deviceId`, {
            type: 'state',
            common: { name: 'Device ID', type: 'string', role: 'value', read: true, write: false },
            native: {},
        });
        await this.setStateAsync(`${prefix}.deviceId`, { val: String(station.deviceId), ack: true });

        await this.setObjectNotExistsAsync(`${prefix}.enabled`, {
            type: 'state',
            common: { name: 'Aktiv', type: 'boolean', role: 'indicator', read: true, write: false },
            native: {},
        });
        await this.setStateAsync(`${prefix}.enabled`, { val: !!station.enabled, ack: true });

        await this.setObjectNotExistsAsync(`${prefix}.status`, {
            type: 'state',
            common: { name: 'Status (Station)', type: 'string', role: 'value', read: true, write: false },
            native: {},
        });

        await this.setObjectNotExistsAsync(`${prefix}.statusDerived`, {
            type: 'state',
            common: { name: 'Status (aus Ports)', type: 'string', role: 'value', read: true, write: false },
            native: {},
        });

        await this.setObjectNotExistsAsync(`${prefix}.portCount`, {
            type: 'state',
            common: { name: 'Anzahl Ports', type: 'number', role: 'value', read: true, write: false },
            native: {},
        });

        await this.setObjectNotExistsAsync(`${prefix}.lastUpdate`, {
            type: 'state',
            common: { name: 'Letztes Update', type: 'string', role: 'date', read: true, write: false },
            native: {},
        });

        // Parent channel for ports
        await this.setObjectNotExistsAsync(`${prefix}.ports`, {
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

    async onReady() {
        this.log.info('Adapter CPT gestartet');
        this.log.info('Konfiguration (this.config): ' + JSON.stringify(this.config));

        const stationsRaw = this.config.stations || [];
        const intervalMin = Number(this.config.interval) || 5;

        const stations = (Array.isArray(stationsRaw) ? stationsRaw : [])
            .filter((s) => s && typeof s === 'object')
            .map((s, index) => {
                const id = s.id || `station${index + 1}`;
                const deviceId = s.deviceId ?? s.stationId ?? s.id;
                const name = s.name || `station_${id}`;
                const enabled = s.enabled !== false;
                return { ...s, id, deviceId, name, enabled };
            })
            .filter((s) => {
                if (!s.deviceId) {
                    this.log.warn(`Station "${s.name || s.id}" ohne deviceId/stationId – überspringe: ${JSON.stringify(s)}`);
                    return false;
                }
                return true;
            });

        this.log.info(`Anzahl Stationen (gültig): ${stations.length}`);
        this.log.info(`Polling-Intervall: ${intervalMin} Minuten`);

        if (stations.length === 0) {
            this.log.warn('Keine gültigen Stationen in der Konfiguration gefunden');
            return;
        }

        // Create base station objects
        for (const station of stations) {
            const safeName = this.makeSafeName(station.name || `station_${station.id}`);
            const prefix = `stations.${safeName}`;

            await this.ensureStationObjects(prefix, station);

            const initialStatus = station.enabled ? 'initialisiert' : 'deaktiviert';
            await this.setStateAsync(`${prefix}.status`, { val: initialStatus, ack: true });
            await this.setStateAsync(`${prefix}.statusDerived`, { val: initialStatus, ack: true });
            await this.setStateAsync(`${prefix}.lastUpdate`, { val: new Date().toISOString(), ack: true });
        }

        // First update immediately
        try {
            await this.updateAllStations(stations);
        } catch (e) {
            this.log.error(`Fehler bei initialem Update: ${e?.message || e}`);
        }

        // Polling
        this.pollInterval = setInterval(() => {
            this.updateAllStations(stations).catch((e) => this.log.error(`Polling-Fehler: ${e?.message || e}`));
        }, intervalMin * 60 * 1000);
    }

    async updateAllStations(stations) {
        for (const station of stations) {
            const safeName = this.makeSafeName(station.name || `station_${station.id}`);
            const prefix = `stations.${safeName}`;

            if (station.enabled === false) {
                await this.setStateAsync(`${prefix}.status`, { val: 'deaktiviert', ack: true });
                await this.setStateAsync(`${prefix}.statusDerived`, { val: 'deaktiviert', ack: true });
                await this.setStateAsync(`${prefix}.lastUpdate`, { val: new Date().toISOString(), ack: true });
                continue;
            }

            try {
                const url = `https://mc.chargepoint.com/map-prod/v3/station/info?deviceId=${station.deviceId}`;
                this.log.debug(`GET ${url}`);

                const res = await axios.get(url, { timeout: 12000 });
                const data = res.data || {};

                // Station status from API
                const stationStatus = data?.stationStatus || data?.status || 'unknown';
                await this.setStateAsync(`${prefix}.status`, { val: stationStatus, ack: true });

                // Ports
                const portsInfo = data?.portsInfo || {};
                const ports = Array.isArray(portsInfo?.ports) ? portsInfo.ports : [];
                const portCount = Number(portsInfo?.portCount ?? ports.length) || ports.length;
                await this.setStateAsync(`${prefix}.portCount`, { val: portCount, ack: true });

                // Derived status based on ports
                const derived = this.deriveStationStatusFromPorts(ports);
                await this.setStateAsync(`${prefix}.statusDerived`, { val: derived, ack: true });

                // Update each port
                for (let i = 0; i < ports.length; i++) {
                    const port = ports[i] || {};
                    const outletNumber = port.outletNumber ?? port.outlet ?? (i + 1);

                    const portPrefix = await this.ensurePortObjects(prefix, outletNumber);

                    const pStatus = port.status || 'unknown';
                    const pStatusV2 = port.statusV2 || 'unknown';
                    const evseId = port.evseId ? String(port.evseId) : '';

                    // maxPowerKw: may be number or numeric string
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

                await this.setStateAsync(`${prefix}.lastUpdate`, { val: new Date().toISOString(), ack: true });

                this.log.info(`Aktualisiert: ${station.name} → station=${stationStatus}, derived=${derived}, ports=${ports.length}`);
            } catch (err) {
                const msg = err?.message || String(err);
                this.log.error(`Fehler bei ${station.name || station.id}: ${msg}`);
                await this.setStateAsync(`${prefix}.status`, { val: 'Fehler', ack: true });
                await this.setStateAsync(`${prefix}.statusDerived`, { val: 'Fehler', ack: true });
                await this.setStateAsync(`${prefix}.lastUpdate`, { val: new Date().toISOString(), ack: true });
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
