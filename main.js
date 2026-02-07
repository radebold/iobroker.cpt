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

    async onReady() {
        this.log.info('Adapter CPT gestartet');

        // Debug-Ausgabe
        this.log.info('Konfiguration (this.config): ' + JSON.stringify(this.config));

        const stationsRaw = this.config.stations || [];
        const intervalMin = Number(this.config.interval) || 5;

        // Stationen normalisieren (robust + konsistent)
        const stations = (Array.isArray(stationsRaw) ? stationsRaw : [])
            .filter((s) => s && typeof s === 'object')
            .map((s, index) => {
                const id = s.id || `station${index + 1}`; // interne ID
                // ChargePoint erwartet "deviceId" als Query-Param
                const deviceId = s.deviceId ?? s.stationId ?? s.id; // Fallbacks
                const name = s.name || `station_${id}`;

                return { ...s, id, deviceId, name };
            })
            .filter((s) => {
                if (!s.deviceId) {
                    this.log.warn(`Station "${s.name || s.id}" ohne deviceId/stationId – überspringe: ${JSON.stringify(s)}`);
                    return false;
                }
                return true;
            });

        this.log.info(`stations aus Konfig (raw): ${JSON.stringify(stationsRaw)}`);
        this.log.info(`Anzahl Stationen (gültig): ${stations.length}`);
        this.log.info(`Polling-Intervall: ${intervalMin} Minuten`);

        if (stations.length === 0) {
            this.log.warn('Keine gültigen Stationen in der Konfiguration gefunden');
            return;
        }

        // Objekte anlegen
        for (const [index, station] of stations.entries()) {
            const name = station.name || `station_${station.id || index}`;
            const id = station.id;
            const deviceId = station.deviceId;

            const safeName = (name || `station_${id || index}`)
                .toLowerCase()
                .replace(/[^a-z0-9]/g, '_')
                .replace(/_+/g, '_')
                .replace(/^_+|_+$/g, '');

            const prefix = `stations.${safeName}`;

            this.log.info(`Erstelle Objekte für: ${prefix} (Name: ${name}, ID: ${id}, deviceId: ${deviceId})`);

            await this.setObjectNotExistsAsync(prefix, {
                type: 'channel',
                common: { name: name },
                native: {},
            });

            await this.setObjectNotExistsAsync(`${prefix}.deviceId`, {
                type: 'state',
                common: { name: 'Device ID', type: 'string', role: 'value', read: true, write: false },
                native: {},
            });
            await this.setStateAsync(`${prefix}.deviceId`, { val: String(deviceId), ack: true });

            await this.setObjectNotExistsAsync(`${prefix}.status`, {
                type: 'state',
                common: { name: 'Status', type: 'string', role: 'value', read: true, write: false },
                native: {},
            });

            await this.setObjectNotExistsAsync(`${prefix}.lastUpdate`, {
                type: 'state',
                common: { name: 'Letztes Update', type: 'string', role: 'date', read: true, write: false },
                native: {},
            });

            await this.setStateAsync(`${prefix}.status`, { val: 'initialisiert', ack: true });
            await this.setStateAsync(`${prefix}.lastUpdate`, { val: new Date().toISOString(), ack: true });

            this.log.info(`Objekte für ${prefix} erstellt`);
        }

        // Erste Abfrage sofort (await + try/catch)
        try {
            await this.updateAllStations(stations);
        } catch (e) {
            this.log.error(`Fehler bei initialem Update: ${e?.message || e}`);
        }

        // Polling starten (mit .catch, damit keine unhandled rejections entstehen)
        this.pollInterval = setInterval(() => {
            this.updateAllStations(stations).catch((e) => this.log.error(`Polling-Fehler: ${e?.message || e}`));
        }, intervalMin * 60 * 1000);
    }

    async updateAllStations(stations) {
        for (const station of stations) {
            const safeName = (station.name || `station_${station.id}`)
                .toLowerCase()
                .replace(/[^a-z0-9]/g, '_')
                .replace(/_+/g, '_')
                .replace(/^_+|_+$/g, '');

            const prefix = `stations.${safeName}`;

            try {
                const url = `https://mc.chargepoint.com/map-prod/v3/station/info?deviceId=${station.deviceId}`;
                this.log.debug(`GET ${url}`);

                const res = await axios.get(url, { timeout: 12000 });
                const data = res.data;

                const status = data?.stationStatus || data?.status || 'unknown';

                await this.setStateAsync(`${prefix}.status`, { val: status, ack: true });
                await this.setStateAsync(`${prefix}.lastUpdate`, { val: new Date().toISOString(), ack: true });

                this.log.info(`Aktualisiert: ${station.name} → ${status}`);
            } catch (err) {
                const msg = err?.message || String(err);
                this.log.error(`Fehler bei ${station.name || station.id}: ${msg}`);
                await this.setStateAsync(`${prefix}.status`, { val: 'Fehler', ack: true });
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
