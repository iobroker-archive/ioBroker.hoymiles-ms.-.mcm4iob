import { stateConfig, initState, initStates, filterDevId, handleOnlineStatus } from './states';
import type { HoymilesMsAdapter } from '../main';
import type { MqttConnectEvent, MqttMessageEvent, MqttSubscribeEvent } from './mqtt-event-types';

/**
 * HoymilesMqtt - class to handle hoymiles mqtt topics within ioBroker
 *
 */
export class HoymilesMqtt {
    #adapter: HoymilesMsAdapter; /*ioBroker.Adapter;*/
    #log: ioBroker.Log;
    #refreshTimer: ioBroker.Interval | undefined;
    #watchedDevices: string[] = [];

    constructor(adapter: HoymilesMsAdapter /* ioBroker.Adapter */) {
        this.#adapter = adapter;
        this.#log = adapter.log;
        this.#log.debug(`[hoymilesMqtt] initializing`);
    }

    public onUnload(): void {
        this.#refreshTimer && this.#adapter.clearInterval(this.#refreshTimer);
    }

    public onMqttConnect(event: MqttConnectEvent): void {
        this.#log.info(`[hoymilesMQTT] client ${event.clientId} connected from ${event.ip}`);
    }

    public async onMqttMessage(event: MqttMessageEvent): Promise<void> {
        this.#log.silly(`[hoymilesMqtt] process message ${event.topic}: ${event.payload.toString()}`);

        if (!event.topic) {
            this.#log.debug(`[hoymilesMqtt] ignoring empty topic`);
            return;
        }

        const topicDetails = event.topic.split('/');
        if (topicDetails.length < 2) {
            this.#log.debug(`[hoymilesMqtt] ignoring invalid topic ${event.topic}`);
            return;
        }
        const deviceId = topicDetails[2];
        topicDetails[2] = '<dev_id>';
        const topic = topicDetails.join('/');

        await initStates(this.#adapter, deviceId, { clientId: event.clientId });
        await handleOnlineStatus(this.#adapter, deviceId);

        for (const stateKey in stateConfig) {
            if (!stateConfig[stateKey].mqtt || stateConfig[stateKey].mqtt.mqtt_publish !== topic) {
                continue;
            }

            const state = stateConfig[stateKey];

            const stateId = `${filterDevId(deviceId)}.${stateKey}`;
            const mqtt_publish_func = state.mqtt?.mqtt_publish_funct;
            let value = mqtt_publish_func(event);
            if (state.common.type === 'boolean' && value === 'false') {
                value = false;
            }
            if (state.common.type === 'boolean' && value === 'true') {
                value = true;
            }
            if (state.common.type === 'number' && value !== undefined) {
                value = Number(value);
            }

            if (value !== undefined) {
                this.#log.silly(`[hoymilesMqtt] updateing state ${stateId} from ${event.topic} using value ${value}`);
                await initState(this.#adapter, stateId, { clientId: event.clientId });
                await this.#adapter.setState(stateId, value, true);
            } else {
                this.#log.debug(
                    `[hoymilesMqtt] updateing state ${stateId} from ${event.topic} failed, value is undefined`,
                );
            }
        }
    }

    public async onMqttSubscribe(event: MqttSubscribeEvent): Promise<void> {
        this.#log.debug(`[hoymilesMqtt] process subscription ${event.topic}`);

        if (!event.topic) {
            this.#log.debug(`[hoymilesMqtt] ignoring empty topic`);
            return;
        }

        const topicDetails = event.topic.split('/');
        if (topicDetails.length < 2) {
            this.#log.debug(`[hoymilesMqtt] ignoring invalid topic ${event.topic}`);
            return;
        }
        const deviceId = topicDetails[2];

        await initStates(this.#adapter, deviceId, { clientId: event.clientId });
        await handleOnlineStatus(this.#adapter, deviceId);

        const stateKey = event.topic.split('/').slice(3).join('.');
        if (!stateConfig[stateKey]) {
            this.#log.warn(`[hoymilesMqtt] ignoring subscription to unknown key ${stateKey} / topic ${event.topic}`);
            return;
        }

        this.#log.info(`[hoymilesMqtt] device ${deviceId} subscribing to topic ${event.topic}`);

        const filteredDeviceId = filterDevId(deviceId);
        const stateId = `${filteredDeviceId}.${stateKey}`;
        await initState(this.#adapter, stateId, { clientId: event.clientId, topic: event.topic });
        await this.#adapter.subscribeStatesAsync(stateId);

        if (!this.#watchedDevices.includes(filteredDeviceId)) {
            this.#watchedDevices.push(filteredDeviceId);
        }

        if (!this.#refreshTimer) {
            this.#adapter.log.info(`[hoymilesMqtt] staring refreh times`);
            this.#refreshTimer = this.#adapter.setInterval(this.doRefresh.bind(this), 20 * 1000);
        }
    }

    public async onMqttStateChange(id: string, state: ioBroker.State): Promise<void> {
        const deviceId = id.split('.')[2];
        const val = state.val;
        const stateObject = await this.#adapter.getObjectAsync(id);
        const clientId = stateObject?.native?.clientId;
        const topic = stateObject?.native?.topic;

        if (!clientId) {
            this.#adapter.log.debug(`[hoymilesMqtt] state ${id} has no clientId set, ignoring change`);
            return;
        }

        if (!topic) {
            this.#adapter.log.debug(`[hoymilesMqtt] state ${id} has no registered topic, ignoring change`);
            return;
        }

        this.#adapter.log.debug(
            `[hoymilesMqtt] device ${deviceId} changed value (${val}) at ${id} will be published at ${topic}`,
        );

        const payload = val?.toString() || '';
        this.#adapter.mqttPublish(clientId, { topic: topic, payload: payload, qos: 0, retain: false });
    }

    #refreshCnt = 0;
    private async doRefresh(): Promise<void> {
        this.#log.debug(`[hoymilesMqtt] doRrefresh starting check`);
        this.#refreshCnt = (this.#refreshCnt + 1) % 2;

        for (const deviceId of this.#watchedDevices) {
            let state: ioBroker.State | null | undefined;
            state = await this.#adapter.getStateAsync(`${deviceId}.ems_mode.command`);
            if (state?.val !== 'mqtt_ctrl') {
                this.#log.debug(`[hoymilesMqtt] ${deviceId} - mqtt_ctrl disabled (${state?.val}), skipping update`);
                continue;
            }

            const id = `${deviceId}.power_ctrl.set`;
            state = await this.#adapter.getStateAsync(`${deviceId}.power_ctrl.set`);
            if (!state) {
                this.#log.warn(`[hoymilesMqtt] ${deviceId} - cannot access state ${id}`);
                continue;
            }
            if (state.val === undefined || state.val === null) {
                this.#log.debug(`[hoymilesMqtt] ${deviceId} - no value set for state ${id}, skipping update`);
                continue;
            }

            let val = parseFloat(state.val?.toString() || '0');
            val = val + 0.1 * (this.#refreshCnt + 1);

            const stateObject = await this.#adapter.getObjectAsync(`${id}`);
            const clientId = stateObject?.native?.clientId;
            const topic = stateObject?.native?.topic;

            if (!clientId) {
                this.#log.debug(`[hoymilesMqtt] ${deviceId} - state ${id} has no clientId set, ignoring change`);
                return;
            }

            if (!topic) {
                this.#log.debug(`[hoymilesMqtt] ${deviceId} - state ${id} has no registered topic, ignoring change`);
                return;
            }

            this.#log.debug(`[hoymilesMqtt] ${deviceId} - new value (${val}) at ${id} will be published at ${topic}`);

            const payload = val?.toString() || '';
            this.#adapter.mqttPublish(clientId, { topic: topic, payload: payload, qos: 0, retain: false });
        }
    }
}
