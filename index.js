const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const dgram = require('dgram');
const { URL } = require('url');
const xml2js = require('xml2js');

class DLNADiscoverer {
    constructor() {
        this.activeSockets = new Set();
        this.parser = new xml2js.Parser({
            explicitArray: false,
            mergeAttrs: true,
            ignoreAttrs: false,
            tagNameProcessors: [(name) => name.split(':').pop()],
            attrNameProcessors: [(name) => name.replace(/^xmlns:/i, '')],
        });
    }

    async discover(timeout = 5000) {
        const devices = new Map();
        const socket = dgram.createSocket('udp4');
        this.activeSockets.add(socket);

        return new Promise((resolve) => {
            let timer;
            const cleanup = () => {
                clearTimeout(timer);
                socket.close();
                this.activeSockets.delete(socket);
                console.log('[Discovery] Cleanup completed');
            };

            socket.on('error', (err) => {
                console.error('[Socket Error]', err.message);
                cleanup();
                resolve([]);
            });

            socket.bind(1900, () => {
                socket.setBroadcast(true);
                socket.addMembership('239.255.255.250');
                socket.addMembership('224.0.0.251');
                const mx = Math.floor(Math.random() * 3) + 1;

                const searchMsg = [
                    'M-SEARCH * HTTP/1.1',
                    'HOST: 239.255.255.250:1900',
                    'MAN: "ssdp:discover"',
                    `MX: ${mx}`,
                    'ST: urn:schemas-upnp-org:service:AVTransport:1',
                    '\r\n',
                ].join('\r\n');
                console.log('[Discovery] Sending search message');

                socket.send(searchMsg, 1900, '239.255.255.250');
                socket.send(searchMsg, 1900, '255.255.255.255');

                timer = setTimeout(() => {
                    console.log('[Discovery] Timeout reached');
                    cleanup();
                    resolve([...devices.values()]);
                }, timeout);

                socket.on('message', async (msg, rinfo) => {
                    try {
                        const headers = msg
                            .toString()
                            .split('\r\n')
                            .reduce((acc, line) => {
                                const colonIndex = line.indexOf(':');
                                if (colonIndex === -1) return acc;

                                const key = line
                                    .slice(0, colonIndex)
                                    .trim()
                                    .toLowerCase();
                                const value = line.slice(colonIndex + 1).trim();

                                if (key && value) acc[key] = value;
                                return acc;
                            }, {});

                        // 调试日志
                        // console.log('[Discovery] Parsed headers:', {
                        //     ...headers,
                        //     rawMessage:
                        //         msg.toString().substring(0, 200) + '...', // 截断长消息
                        // });

                        if (!headers.location || devices.has(headers.location))
                            return;

                        console.log(
                            `[Discovery] Found device at ${headers.location}`,
                        );
                        const device = await this.parseDeviceDescription(
                            headers.location,
                        );

                        if (device) {
                            device.ip = rinfo.address;
                            devices.set(headers.location, device);
                            console.log(
                                `[Found] ${device.name} (${rinfo.address}:${rinfo.port})`,
                            );
                        }
                    } catch (err) {
                        console.error(
                            '[Message Processing Error]',
                            err.message,
                        );
                    }
                });
            });
        });
    }

    async parseDeviceDescription(location) {
        try {
            // 增强URL验证
            if (!this.isValidHttpUrl(location)) {
                console.error(
                    `[Parse Error] Invalid Location URL: ${location}`,
                );
                return null;
            }

            console.log(`[Parse] Fetching device description from ${location}`);
            const res = await fetch(location);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);

            const xml = await res.text();
            const result = await this.parser.parseStringPromise(xml);
            const device = result.root?.device || result.device;

            if (!device) {
                console.error(
                    `[Parse Error] No device info in description: ${location}`,
                );
                return null;
            }

            // 服务发现逻辑
            const avTransport = this.findAVTransportService(device.serviceList);
            if (!avTransport) {
                console.log(
                    `[Parse Warning] No AVTransport service at ${location}`,
                );
                return null;
            }
            console.log(
                '🚀 ~ DLNADiscoverer ~ parseDeviceDescription ~ location:',
                location,
            );

            const url = new URL(location);

            return {
                name: device.friendlyName?.trim() || 'Unnamed Device',
                type: this.parseDeviceType(device.deviceType),
                manufacturer:
                    device.manufacturer?.trim() || 'Unknown Manufacturer',
                controlURL: this.normalizeURL(location, avTransport.controlURL),
                ip: 'Pending',
                originalLocation: location,
                port: url.port,
            };
        } catch (err) {
            console.error(`[Parse Error] ${location}: ${err.message}`);
            return null;
        }
    }

    // 新增URL验证方法
    isValidHttpUrl(url) {
        try {
            const parsed = new URL(url);
            return parsed.protocol === 'http:' || parsed.protocol === 'https:';
        } catch {
            return false;
        }
    }

    findAVTransportService(node, services = []) {
        if (!node) return null;

        if (Array.isArray(node)) {
            for (const item of node) {
                const found = this.findAVTransportService(item, services);
                if (found) return found;
            }
        } else if (typeof node === 'object') {
            if (
                node.serviceType?.startsWith(
                    'urn:schemas-upnp-org:service:AVTransport:',
                )
            ) {
                return {
                    serviceType: node.serviceType,
                    controlURL: node.controlURL,
                };
            }

            for (const value of Object.values(node)) {
                const found = this.findAVTransportService(value, services);
                if (found) return found;
            }
        }
        return null;
    }

    normalizeURL(base, path) {
        try {
            const baseURL = new URL(base);
            const resolved = new URL(path, baseURL.origin);
            resolved.pathname = resolved.pathname.replace(/\/+/g, '/');
            return resolved.href;
        } catch {
            console.error(
                `[URL Error] Failed to normalize ${path} with base ${base}`,
            );
            return null;
        }
    }

    parseDeviceType(typeStr) {
        const parts = (typeStr || '').split(':');
        return parts.length >= 4 ? parts[3] : 'MediaRenderer';
    }

    shutdown() {
        console.log('[Shutdown] Closing', this.activeSockets.size, 'sockets');
        this.activeSockets.forEach((socket) => {
            try {
                socket.removeAllListeners();
                socket.close();
            } catch (err) {
                console.error('[Socket Close Error]', err.message);
            }
        });
        this.activeSockets.clear();
    }
}

class DLNAController {
    constructor() {
        this.parser = new xml2js.Parser({
            explicitArray: false,
            ignoreAttrs: true,
            tagNameProcessors: [(name) => name.split(':').pop()],
        });
    }

    // 新增投屏核心方法
    async play(deviceLocation, mediaURL) {
        try {
            // 获取设备详情
            const device = await this.getDeviceDetails(deviceLocation.location);
            if (!device || !device.avTransport) {
                throw new Error('设备不支持投屏功能');
            }

            const controlUrlFull = `http://${deviceLocation.ip}:${deviceLocation.port}${device.avTransport.controlURL}`;

            // 设置媒体URI
            await this.sendSoapRequest(
                controlUrlFull,
                device.avTransport.serviceType,
                'SetAVTransportURI',
                `<CurrentURI>${this.escapeXml(mediaURL)}</CurrentURI>
                 <CurrentURIMetaData></CurrentURIMetaData>`,
            );

            // 开始播放
            await this.sendSoapRequest(
                controlUrlFull,
                device.avTransport.serviceType,
                'Play',
                '<Speed>1</Speed>',
            );

            return { success: true };
        } catch (err) {
            console.error('[Play Error]', err);
            return { success: false, error: err.message };
        }
    }

    async getDeviceDetails(location) {
        console.log(
            '🚀 ~ DLNAController ~ getDeviceDetails ~ location:',
            location,
        );
        try {
            const res = await fetch(location);
            const xml = await res.text();
            const result = await this.parser.parseStringPromise(xml);
            const device = result.root?.device || result.device;

            return {
                avTransport: this.findAVTransportService(device.serviceList),
                controlURL: location,
            };
        } catch (err) {
            throw new Error(`设备信息获取失败: ${err.message}`);
        }
    }

    async sendSoapRequest(controlURL, serviceType, action, body) {
        const soapEnvelope = `
            <?xml version="1.0" encoding="utf-8"?>
            <s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" 
                        s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
                <s:Body>
                    <u:${action} xmlns:u="${serviceType}">
                        ${body}
                    </u:${action}>
                </s:Body>
            </s:Envelope>
        `;

        const headers = {
            'Content-Type': 'text/xml; charset="utf-8"',
            SOAPAction: `"${serviceType}#${action}"`,
            Connection: 'close',
            'Content-Length': Buffer.byteLength(soapEnvelope),
        };

        console.log(
            '🚀 ~ DLNAController ~ sendSoapRequest ~ soapEnvelope:',
            soapEnvelope,
        );
        const response = await fetch(controlURL, {
            method: 'POST',
            headers,
            body: soapEnvelope,
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`SOAP请求失败: ${response.status} - ${errorText}`);
        }

        return this.parser.parseStringPromise(await response.text());
    }

    escapeXml(str) {
        return str.replace(
            /[<>&'"]/g,
            (char) =>
                ({
                    '<': '&lt;',
                    '>': '&gt;',
                    '&': '&amp;',
                    "'": '&apos;',
                    '"': '&quot;',
                }[char]),
        );
    }

    findAVTransportService(serviceList) {
        const services = Array.isArray(serviceList.service)
            ? serviceList.service
            : [serviceList.service];

        const avTransport = services.find((s) =>
            s.serviceType?.startsWith(
                'urn:schemas-upnp-org:service:AVTransport:',
            ),
        );

        if (!avTransport) return null;

        return {
            controlURL: avTransport.controlURL,
            serviceType: avTransport.serviceType,
        };
    }
}

// 服务初始化
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const discoverer = new DLNADiscoverer();
// 初始化控制器
const controller = new DLNAController();

app.use(express.static('public'));

app.get('/discover', async (req, res) => {
    try {
        console.log('[HTTP] Received discover request');
        const devices = (await discoverer.discover(3000)).filter(Boolean);
        res.json(
            devices.map((d) => ({
                name: d.name,
                ip: d.ip,
                type: d.type,
            })),
        );
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 增强版WebSocket处理
wss.on('connection', (ws) => {
    console.log('[WS] New connection');
    let isAlive = true;
    const heartbeat = setInterval(() => {
        if (!isAlive) return ws.terminate();
        isAlive = false;
        ws.ping();
    }, 30000);

    ws.on('message', async (message) => {
        try {
            const command = JSON.parse(message.toString());
            console.log('🚀 ~ ws.on ~ command:', command);
            console.log(`[WS] Received command: ${command.type}`);

            if (command.type === 'discover') {
                const devices = (await discoverer.discover(3000))
                    .filter(Boolean)
                    .map((d) => ({
                        ...d,
                        name: d.name,
                        ip: d.ip,
                        controlURL: d.controlURL,
                        type: d.type,
                    }));

                ws.send(
                    JSON.stringify({
                        type: 'devices',
                        data: devices,
                        timestamp: Date.now(),
                    }),
                );
            } else if (command.type === 'play') {
                // 增加参数校验
                if (!command.data?.device || !command.data?.mediaURL) {
                    return ws.send(
                        JSON.stringify({
                            type: 'error',
                            data: '无效的请求参数',
                        }),
                    );
                }

                console.log(`[WS] Play命令设备: ${command.data.mediaURL}`);
                const result = await controller.play(
                    command.data.device, // 传递完整设备对象
                    command.data.mediaURL,
                );
                ws.send(
                    JSON.stringify({
                        type: 'result',
                        data: result,
                    }),
                );
            }
        } catch (err) {
            console.error('[WS Error]', err.message);
            ws.send(
                JSON.stringify({
                    type: 'ERROR',
                    message: 'Invalid command format',
                    details: err.message,
                }),
            );
        }
    });

    ws.on('pong', () => {
        isAlive = true;
        console.log('[WS] Received pong');
    });

    ws.on('close', () => {
        clearInterval(heartbeat);
        console.log('[WS] Connection closed');
    });
});

// 优雅关闭处理
const cleanShutdown = () => {
    console.log('\n[Shutdown] Initiating...');

    // 第一步：关闭设备发现
    discoverer.shutdown();

    // 第二步：关闭WebSocket连接
    wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
            client.close(1001, 'Server shutting down');
        }
    });

    // 第三步：关闭WebSocket服务器
    wss.close(() => {
        console.log('[Shutdown] WebSocket server closed');

        // 第四步：关闭HTTP服务器
        server.close(() => {
            console.log('[Shutdown] HTTP server closed');
            process.exit(0);
        });
    });

    // 强制退出保护
    setTimeout(() => {
        console.error('[Shutdown] Force exit after timeout');
        process.exit(1);
    }, 5000).unref();
};

process.on('SIGINT', cleanShutdown);
process.on('SIGTERM', cleanShutdown);

server.listen(3000, () => {
    console.log('DLNA服务运行在：http://localhost:3000');
    console.log('使用 Ctrl+C 停止服务');
});
