'use strict';

const utils = require('@iobroker/adapter-core');
const axios = require('axios');

class CptAdapter extends utils.Adapter {
    constructor(options) {
        super({
            ...options,
            name: 'cpt',
        });

        this.on('ready', this.onReady.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    async onReady() {
        this.log.info('Adapter CPT gestartet');

        // Sehr wichtige Debug-Ausgabe
        this.log.info('Konfiguration (this.config): ' + JSON.stringify(this.config));

        const stations = this.config.stations || [];
        const intervalMin = Number(this.config.interval) || 5;

        this.log.info(`stations aus Konfig: ${JSON.stringify(stations)}`);
        this.log.info(`Anzahl Stationen: ${stations.length}`);
        this.log.info(`Polling-Intervall: ${intervalMin} Minuten`);

        if (!Array.isArray(stations) || stations.length === 0) {
            this.log.warn('Keine gültigen Stationen in der Konfiguration gefunden');
            return;
        }

        for (const [index, station] of stations.entries()) {
            if (!station || typeof station !== 'object') {
                this.log.warn(`Station ${index} ist ungültig: ${JSON.stringify(station)}`);
                continue;
            }

            const name = station.name || `station_${station.id || index}`;
            const id = station.id;

            if (!id) {
                this.log.warn(`Station "${name}" hat keine deviceId – überspringe`);
                continue;
            }

            const safeName = name
                .toLowerCase()
                .replace(/[^a-z0-9]/g, '_')
                .replace(/_+/g, '_')
                .replace(/^_+|_+$/g, '');

            const prefix = `stations.${safeName}`;

            this.log.info(`Erstelle Objekte für: ${prefix} (Name: ${name}, ID: ${id})`);

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
            await this.setStateAsync(`${prefix}.deviceId`, { val: String(id), ack: true });

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

        // Erste Abfrage sofort
        this.updateAllStations(stations);

        // Polling starten
        this.pollInterval = setInterval(() => this.updateAllStations(stations), intervalMin * 60 * 1000);
    }

    async updateAllStations(stations) {
        for (const station of stations) {
            const safeName = station.name
                .toLowerCase()
                .replace(/[^a-z0-9]/g, '_')
                .replace(/_+/g, '_')
                .replace(/^_+|_+$/g, '');

            const prefix = `stations.${safeName}`;

            try {
                const url = `https://mc.chargepoint.com/map-prod/v3/station/info?deviceId=${station.id}`;
                this.log.debug(`GET ${url}`);

                const res = await axios.get(url, { timeout: 12000 });
                const data = res.data;

                await this.setStateAsync(`${prefix}.status`, { val: data?.stationStatus || 'unknown', ack: true });
                await this.setStateAsync(`${prefix}.lastUpdate`, { val: new Date().toISOString(), ack: true });

                this.log.info(`Aktualisiert: ${station.name} → ${data?.stationStatus || 'kein Status'}`);
            } catch (err) {
                this.log.error(`Fehler bei ${station.name}: ${err.message}`);
                await this.setStateAsync(`${prefix}.status`, { val: 'Fehler', ack: true });
            }
        }
    }

    onUnload(callback) {
        if (this.pollInterval) clearInterval(this.pollInterval);
        callback();
    }
}

if (require.main !== module) {
    module.exports = (options) => new CptAdapter(options);
} else {
    new CptAdapter();
}