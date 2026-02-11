
'use strict';
const utils = require('@iobroker/adapter-core');

class CptAdapter extends utils.Adapter {

    constructor(options) {
        super({
            ...options,
            name: 'cpt',
        });
        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
    }

    async onReady() {
        this.log.info('CPT 0.2.7-dev.0 gestartet');

        await this.setObjectNotExistsAsync('testNotifyAll', {
            type: 'state',
            common: {
                name: 'Test Notify All',
                type: 'boolean',
                role: 'button',
                read: false,
                write: true
            },
            native: {}
        });

        this.subscribeStates('*');
    }

    async onStateChange(id, state) {
        if (!state || state.ack) return;

        if (id.endsWith('testNotify')) {
            await this.sendTestNotify(id);
        }

        if (id === this.namespace + '.testNotifyAll') {
            await this.sendGlobalTest();
            await this.setStateAsync('testNotifyAll', false, true);
        }
    }

    async sendTestNotify(id) {
        this.log.info('TEST Notify ausgelöst für ' + id);
        await this.setStateAsync(id, false, true);
    }

    async sendGlobalTest() {
        this.log.info('GLOBAL TEST Notify ausgelöst');
    }
}

if (require.main !== module) {
    module.exports = (options) => new CptAdapter(options);
} else {
    new CptAdapter();
}
