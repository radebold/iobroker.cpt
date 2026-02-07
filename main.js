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
        this.log.info('ChargePoint Adapter gestartet');

        const stations = this.config.stations || [];
        this.log.info(`Anzahl Stationen in Konfig: ${stations.length}`);

        if (stations.length === 0) {
            this.log.warn('Keine Stationen konfiguriert');
            return;
        }

        // States für jede Station erstellen
        for (const station of stations) {
            const name = station.name || `station_${station.id}`;
            const safeName = name.replace(/[^a-z0-9]/gi, '_').toLowerCase();
            const prefix = `stations.${safeName}`;

            await this.setObjectNotExistsAsync(prefix, {
                type: 'channel',
                common: { name: name },
                native: {},
            });

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

            // Beispiel: Dummy-Wert setzen
            await this.setStateAsync(`${prefix}.status`, { val: 'initialisiert', ack: true });
            await this.setStateAsync(`${prefix}.lastUpdate`, { val: new Date().toISOString(), ack: true });
        }
    }

    onUnload(callback) {
        callback();
    }
}

if (require.main !== module) {
    module.exports = (options) => new CptAdapter(options);
} else {
    new CptAdapter();
}