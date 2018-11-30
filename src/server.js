/**
 * * Created by lee on 2018/2/2
 */

import { log, check, is, isPromise, getResponseTemplate } from './utils';
import CONSTANTS from './constants';

function getIframeIdByEvent (e) {
    let id = '';
    document.querySelectorAll('iframe').forEach((iframe) => {
        if(iframe.contentWindow === e.source) {
            id = iframe.id; // 未设置ID为空字符串
        }
    })
    return id;
}

class Server {
    constructor (props) {
        check(props.validator, is.notUndef, 'validator is required');
        this.$$symbol = props.symbol || 'POST_MESSAGE_IM';
        this.validator = props.validator || function() {return true;};
        // 返回null表示中断本次请求
        this.dataFilter = props.dataFilter || function(data) {return data};
        this.__TEST__ = props.__TEST__ || false;
        this.CONSTANTS = CONSTANTS;
        this.init();
    }

    static CONSTANTS = CONSTANTS;

    init = () => {
        if(!this.__TEST__) {
            this.subscribe();
        }
        // 注册离线消息
        this.on({
            type: CONSTANTS.TYPE.OFFLINE,
            callback: this.handleOfflinePool
        });
    };

    subscribe = () => {
        window.addEventListener('message', (e) => {
            let data = e.data;
            try {
                if(is.string(data)) {
                    data = JSON.parse(data);
                }
            } catch(err) {
                if(data && data.type === 'webpackOk') return;
                log('error', 'json parse error', err.message);
                // 提前结束
                return;
            }
            if(data && (data.$$symbol === this.$$symbol)) {
                data.token.domId = getIframeIdByEvent(e);
                this.distribute(data);
            }
        }, false);
    };

    distribute = (data) => {
        check(data, is.notUndef, 'data is required');
        check(data.token, is.notUndef, 'token is required');

        let res = this.validator(data.token);
        if(isPromise(res)) {
            res.then((ok) => {
                this.handleValidator(ok, data);
            }).catch((err) => {
                log('error', 'validator error', err);
            })
        } else {
            this.handleValidator(res, data);
        }
    };

    handleValidator = (ok = false, data) => {
        if(ok) {
            this.handleMonitorResponse(data);
        } else {
            this.response(Object.assign({}, data, { data: getResponseTemplate(401) }))
        }
    };

    postMessageToChild = (iframe, data) => {
        let win = iframe.contentWindow;
        check(win.postMessage, is.notUndef, 'can not find the frame window');
        win.postMessage(JSON.stringify(data), '*');
    };

    getFrameWindow = (id) => {
        return document.getElementById(id) || null;
    };

    getMeta = (meta) => {
        // responseTime 上层响应时间
        if(!meta) {
            meta = {};
        }
        meta.responseTime = new Date().valueOf();
        return meta;
    };

    response = (id, type, data) => {
        // 兼容两种格式
        // response(id, type, data)
        // response(data)
        if(is.string(id)) {
            check(type, is.notUndef, 'type is required');
            check(data, is.notUndef, 'data is required');
            return this._response({
                type: type,
                data: data,
                token: {
                    // 参考 client.distribute 方法
                    // id: id
                    domId: id
                }
            });
        } else {
            // 如果只传一个参数，则第一个参数包含完整的信息
            check(id, is.object, 'id should be a data object');
            return this._response(id);
        }
    };

    _response = (data) => {
        let { token: { id, domId } } = data;

        data.$$symbol = this.$$symbol;
        data.meta = this.getMeta(data.meta);

        // 数据过滤
        data = this.dataFilter(data);
        if(data === null) {
            return;
        }

        // 对server端约定，优先使用domId进程通信
        let frame = this.getFrameWindow(domId || id);
        // TODO 由frame可用性切到程序可用性
        if(frame) {
            this.postMessageToChild(frame, data)
        } else {
            this.addOfflinePool(data);
        }
        return data;
    };

    offlinePool = {};
    addOfflinePool = (data) => {
        let { type, token: { id, domId } } = data;
        id = domId || id;
        if(!this.offlinePool[id]) {
            this.offlinePool[id] = []
        }
        // 如果发送离线消息失败，将数据拍平，丢掉离线消息体本身
        if(type === CONSTANTS.TYPE.OFFLINE) {
            this.offlinePool[id] = this.offlinePool[id].concat(data.data);
        } else {
            this.offlinePool[id].push(data);
        }
    };
    removeOfflinePool = (frameId) => {
        // 暂时将粒度做到frame，获取离线时，一次性全返回
        this.offlinePool[frameId] = [];
    };
    handleOfflinePool = (err, data) => {
        // 当触发获取离线消息时，frame对象是准备好的
        let { token: { id, domId } } = data;
        id = domId || id;
        let offlineResponse = this.offlinePool[id] || [];
        this.removeOfflinePool(id);
        // 这里先按一次性处理，坏处是消息体结构暴露给业务方了
        this._response(Object.assign({}, data, { data: offlineResponse }));
    };

    // 注册on事件
    on = (data, callback) => {
        data.callback = data.callback || callback;
        this.addMonitorPool(data);
        return data;
    };

    // 监听事件池
    monitorPool = {};
    addMonitorPool = (data) => {
        check(data.type, is.notUndef, 'type is required');
        check(data.callback, is.notUndef, 'callback is required');

        if(!this.monitorPool[data.type]) {
            this.monitorPool[data.type] = [data];
        } else {
            this.monitorPool[data.type].push(data);
        }
    };
    handleMonitorResponse = (data) => {
        let { type } = data;
        check(type, is.notUndef, 'the type info in the client request is required');
        // 遍历得到所有符合的类型
        let monitorData;
        let monitorKeys = Object.keys(this.monitorPool);
        monitorKeys.forEach((t) => {
            // 先找到类型数据
            if(type === t) {
                // 再通知数据中所有注册的事件
                monitorData = this.monitorPool[t];
                check(monitorData, is.array, 'the monitor data is not a array type');
                monitorData.forEach((m) => {
                    m.callback(null, data);
                });
            }
        });

        // 未被注册处理的事件
        if(monitorKeys.indexOf(type) === -1) {
            this.response(Object.assign({}, data, { data: getResponseTemplate(404) }))
        }
    };
}

Server.getResponseTemplate = getResponseTemplate;
export default Server;
