const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const dgram = require('dgram');
const { URL } = require('url');
const xml2js = require('xml2js');
const fetch = require('node-fetch');

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
            let timer; // 修复作用域问题
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

            socket.bind(() => {
                try {
                    socket.addMembership('239.255.255.250');
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
                    socket.send(
                        searchMsg,
                        1900,
                        '239.255.255.250',
                        (err, bytes) => {
                            if (err) console.error('[Socket Send Error]', err);
                            else console.log(`[Discovery] Sent ${bytes} bytes`);
                            console.log(
                                '🚀 ~ DLNADiscoverer ~ socket.send ~ bytes:',
                                bytes,
                            );
                        },
                    );
                } catch (err) {
                    console.error('[Discovery Init Error]', err);
                    cleanup();
                    resolve([]);
                }

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
                                const [key, value] = line
                                    .split(':')
                                    .map((s) => s.trim());
                                if (key && value)
                                    acc[key.toLowerCase()] = value;
                                return acc;
                            }, {});

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
                                `[Found] ${device.name} (${rinfo.address})`,
                            );
                        }
                    } catch (err) {
                        console.error('[Message Error]', err.message);
                    }
                });
            });
        });
    }

    async parseDeviceDescription(location) {
        try {
            console.log(`[Parse] Fetching ${location}`);
            const res = await fetch(location);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);

            const xml = await res.text();
            const result = await this.parser.parseStringPromise(xml);
            const device = result.root?.device || result.device;

            const findServices = (node, services = []) => {
                if (!node) return services;
                if (Array.isArray(node)) {
                    node.forEach((item) => findServices(item, services));
                } else if (typeof node === 'object') {
                    if (node.serviceType) {
                        services.push({
                            serviceType: node.serviceType,
                            controlURL: this.normalizeURL(
                                location,
                                node.controlURL,
                            ),
                        });
                    }
                    Object.values(node).forEach((value) =>
                        findServices(value, services),
                    );
                }
                return services;
            };

            const avTransport = findServices(device.serviceList).find((s) =>
                s.serviceType.startsWith(
                    'urn:schemas-upnp-org:service:AVTransport:',
                ),
            );

            return avTransport
                ? {
                      name: device.friendlyName?.trim() || 'Unknown Device',
                      type: this.parseDeviceType(device.deviceType),
                      manufacturer: device.manufacturer?.trim() || 'Unknown',
                      controlURL: avTransport.controlURL,
                      ip: 'Pending',
                  }
                : null;
        } catch (err) {
            console.error(`[Parse Error] ${location} - ${err.message}`);
            return null;
        }
    }

    normalizeURL(base, path) {
        try {
            const baseURL = new URL(base);
            const resolved = new URL(path, baseURL.origin);
            resolved.pathname = resolved.pathname.replace(/\/+/g, '/');
            return resolved.href;
        } catch {
            return null;
        }
    }

    parseDeviceType(typeStr) {
        return (typeStr || '').split(':').slice(-2, -1)[0] || 'MediaRenderer';
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

// 服务初始化
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const discoverer = new DLNADiscoverer();

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
            console.log(`[WS] Received command: ${command.type}`);

            if (command.type === 'discover') {
                const devices = (await discoverer.discover(3000))
                    .filter(Boolean)
                    .map((d) => ({
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
