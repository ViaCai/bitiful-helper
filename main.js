const { Plugin, PluginSettingTab, Setting, ItemView, WorkspaceLeaf, Notice, Menu, Modal, MarkdownView, TFile } = require('obsidian');

// ==================== 常量定义 ====================
const VIEW_TYPE_BITIFUL = "bitiful-sidebar";
const DEFAULT_SETTINGS = {
    accessKeyId: '',
    secretAccessKey: '',
    bucket: '',
    endpoint: 'https://s3.bitiful.net',
    region: 'cn-east-1',
    customDomain: '',
    defaultLinkFormat: 'markdown',
    uploadPathPrefix: 'obsidian/',
    autoRename: true,
    searchAllFiles: true,
    enableImagePreview: true,
    enableImageCompress: true,
    compressQuality: 80,
    linkTemplate: '![{{filename}}]({{url}})',
    maxRecentFiles: 10,
    sortBy: 'name',
    sortOrder: 'asc',
    // 水印设置
    enableWatermark: false,
    watermarkText: '',
    watermarkPosition: 'bottom-right',
    watermarkOpacity: 0.5,
    watermarkFontSize: 24,
    // 自动同步
    autoSyncFolder: '',
    autoSyncEnabled: false,
    // 存储桶间复制
    targetBucket: '',
    targetEndpoint: '',
    targetRegion: 'cn-east-1',
};

const IMAGE_EXTS = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'ico'];
const VIDEO_EXTS = ['mp4', 'webm', 'ogg', 'mov', 'avi', 'mkv'];
const AUDIO_EXTS = ['mp3', 'wav', 'ogg', 'flac', 'aac', 'm4a'];
const DOC_EXTS = ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'md'];

// 缤纷云价格（用于估算消费）
const BITIFUL_PRICES = {
    storage: [
        { limit: 50 * 1024 * 1024 * 1024, price: 0 },
        { limit: 1000 * 1024 * 1024 * 1024, price: 0.065 / 1024 / 1024 / 1024 / 30 / 24 },
        { limit: 10000 * 1024 * 1024 * 1024, price: 0.055 / 1024 / 1024 / 1024 / 30 / 24 },
        { limit: Infinity, price: 0.045 / 1024 / 1024 / 1024 / 30 / 24 },
    ],
    traffic: [
        { limit: 10 * 1024 * 1024 * 1024, price: 0 },
        { limit: 1000 * 1024 * 1024 * 1024, price: 0.12 / 1024 / 1024 / 1024 },
        { limit: 10000 * 1024 * 1024 * 1024, price: 0.10 / 1024 / 1024 / 1024 },
        { limit: Infinity, price: 0.09 / 1024 / 1024 / 1024 },
    ],
    request: [
        { limit: 10 * 10000, price: 0 },
        { limit: Infinity, price: 0.01 / 10000 },
    ]
};

// ==================== AWS Signature V4 工具 ====================
class S3Client {
    constructor(settings) {
        this.settings = settings;
        this.endpoint = settings.endpoint.replace(/\/$/, '');
        this.emptyHash = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
    }

    bufToHex(buf) {
        return Array.from(new Uint8Array(buf))
            .map(b => b.toString(16).padStart(2, '0'))
            .join('');
    }

    async sha256(message) {
        const encoder = new TextEncoder();
        const data = encoder.encode(message);
        const hashBuffer = await crypto.subtle.digest('SHA-256', data);
        return this.bufToHex(hashBuffer);
    }

    async hmacSha256(key, message) {
        const encoder = new TextEncoder();
        const cryptoKey = await crypto.subtle.importKey(
            'raw',
            typeof key === 'string' ? encoder.encode(key) : key,
            { name: 'HMAC', hash: 'SHA-256' },
            false,
            ['sign']
        );
        const signature = await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(message));
        return signature;
    }

    async hmacSha256Hex(key, message) {
        const sig = await this.hmacSha256(key, message);
        return this.bufToHex(sig);
    }

    async getSigningKey(secretKey, dateStamp, region, service) {
        const kDate = await this.hmacSha256('AWS4' + secretKey, dateStamp);
        const kRegion = await this.hmacSha256(kDate, region);
        const kService = await this.hmacSha256(kRegion, service);
        const kSigning = await this.hmacSha256(kService, 'aws4_request');
        return kSigning;
    }

    awsUriEncode(str) {
        return encodeURIComponent(str).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
    }

    buildCanonicalQueryString(params) {
        const keys = Object.keys(params).sort();
        const pairs = [];
        for (const key of keys) {
            const val = params[key];
            pairs.push(`${this.awsUriEncode(key)}=${this.awsUriEncode(val)}`);
        }
        return pairs.join('&');
    }

    async signRequest(method, path, queryParams = {}, headers = {}, payload = '') {
        const accessKey = this.settings.accessKeyId;
        const secretKey = this.settings.secretAccessKey;
        const region = this.settings.region;
        const service = 's3';

        const now = new Date();
        const dateStamp = now.toISOString().slice(0, 10).replace(/-/g, '');
        const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');

        const host = new URL(this.endpoint).host;
        const allHeaders = { ...headers };
        allHeaders['host'] = host;
        allHeaders['x-amz-date'] = amzDate;
        allHeaders['x-amz-content-sha256'] = payload === '' ? this.emptyHash : await this.sha256(payload);

        const sortedHeaderNames = Object.keys(allHeaders).sort();
        const canonicalHeaders = sortedHeaderNames
            .map(k => `${k.toLowerCase()}:${allHeaders[k].trim()}\n`)
            .join('');
        const signedHeaders = sortedHeaderNames.map(k => k.toLowerCase()).join(';');

        const canonicalQueryString = this.buildCanonicalQueryString(queryParams);

        const payloadHash = allHeaders['x-amz-content-sha256'];
        const canonicalRequest = [
            method.toUpperCase(),
            path,
            canonicalQueryString,
            canonicalHeaders,
            signedHeaders,
            payloadHash
        ].join('\n');

        const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
        const canonicalRequestHash = await this.sha256(canonicalRequest);
        const stringToSign = [
            'AWS4-HMAC-SHA256',
            amzDate,
            credentialScope,
            canonicalRequestHash
        ].join('\n');

        const signingKey = await this.getSigningKey(secretKey, dateStamp, region, service);
        const signature = await this.hmacSha256Hex(signingKey, stringToSign);

        const authorization = `AWS4-HMAC-SHA256 Credential=${accessKey}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

        return {
            headers: {
                ...allHeaders,
                'Authorization': authorization
            }
        };
    }

    async listObjects(prefix = '', delimiter = '/', maxKeys = 1000) {
        const path = `/${this.settings.bucket}/`;
        const queryParams = {
            'list-type': '2',
            'prefix': prefix,
            'delimiter': delimiter,
            'max-keys': String(maxKeys)
        };

        const { headers } = await this.signRequest('GET', path, queryParams);
        const queryString = this.buildCanonicalQueryString(queryParams);
        const url = `${this.endpoint}${path}?${queryString}`;

        const response = await fetch(url, { headers });
        if (!response.ok) {
            const text = await response.text();
            throw new Error(`${response.status}: ${text.substring(0, 200)}`);
        }

        const xmlText = await response.text();
        return this.parseListResponse(xmlText);
    }

    async listAllObjects() {
        const allContents = [];
        let isTruncated = true;
        let continuationToken = '';

        while (isTruncated && allContents.length < 10000) {
            const path = `/${this.settings.bucket}/`;
            const queryParams = {
                'list-type': '2',
                'prefix': '',
                'max-keys': '1000'
            };
            if (continuationToken) {
                queryParams['continuation-token'] = continuationToken;
            }

            const { headers } = await this.signRequest('GET', path, queryParams);
            const queryString = this.buildCanonicalQueryString(queryParams);
            const url = `${this.endpoint}${path}?${queryString}`;

            const response = await fetch(url, { headers });
            const xmlText = await response.text();
            const result = this.parseListResponse(xmlText);

            allContents.push(...result.contents);
            isTruncated = result.isTruncated;
            continuationToken = result.nextToken;
        }

        return allContents;
    }

    parseListResponse(xmlText) {
        const parser = new DOMParser();
        const doc = parser.parseFromString(xmlText, 'text/xml');

        const prefixes = Array.from(doc.querySelectorAll('CommonPrefixes Prefix'))
            .map(el => el.textContent);

        const contents = Array.from(doc.querySelectorAll('Contents')).map(el => ({
            key: el.querySelector('Key')?.textContent || '',
            size: parseInt(el.querySelector('Size')?.textContent || '0'),
            lastModified: el.querySelector('LastModified')?.textContent || '',
            etag: el.querySelector('ETag')?.textContent || ''
        })).filter(item => item.key && item.size > 0);

        const isTruncated = doc.querySelector('IsTruncated')?.textContent === 'true';
        const nextToken = doc.querySelector('NextContinuationToken')?.textContent || '';

        return { prefixes, contents, isTruncated, nextToken };
    }

    async getPresignedUploadUrl(key, expiresIn = 3600) {
        const now = new Date();
        const dateStamp = now.toISOString().slice(0, 10).replace(/-/g, '');
        const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');

        const credential = `${this.settings.accessKeyId}/${dateStamp}/${this.settings.region}/s3/aws4_request`;

        const queryParams = {
            'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
            'X-Amz-Credential': credential,
            'X-Amz-Date': amzDate,
            'X-Amz-Expires': String(expiresIn),
            'X-Amz-SignedHeaders': 'host'
        };

        const path = `/${this.settings.bucket}/${this.awsUriEncode(key).replace(/%2F/g, '/')}`;

        const canonicalRequest = `PUT\n${path}\n${this.buildCanonicalQueryString(queryParams)}\nhost:${new URL(this.endpoint).host}\n\nhost\nUNSIGNED-PAYLOAD`;
        const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${dateStamp}/${this.settings.region}/s3/aws4_request\n${await this.sha256(canonicalRequest)}`;
        const signingKey = await this.getSigningKey(this.settings.secretAccessKey, dateStamp, this.settings.region, 's3');
        const signature = await this.hmacSha256Hex(signingKey, stringToSign);

        queryParams['X-Amz-Signature'] = signature;

        return `${this.endpoint}${path}?${this.buildCanonicalQueryString(queryParams)}`;
    }

    getPublicUrl(key) {
        if (this.settings.customDomain) {
            const domain = this.settings.customDomain.replace(/\/$/, '');
            return `${domain}/${key}`;
        }
        return `${this.endpoint}/${this.settings.bucket}/${key}`;
    }

    async uploadFile(key, file, onProgress) {
        const presignedUrl = await this.getPresignedUploadUrl(key, 3600);

        return new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();

            xhr.upload.addEventListener('progress', (e) => {
                if (e.lengthComputable && onProgress) {
                    onProgress(Math.round((e.loaded / e.total) * 100));
                }
            });

            xhr.addEventListener('load', () => {
                if (xhr.status >= 200 && xhr.status < 300) {
                    resolve(this.getPublicUrl(key));
                } else {
                    reject(new Error(`Upload failed: ${xhr.status}`));
                }
            });

            xhr.addEventListener('error', () => reject(new Error('Upload failed')));
            xhr.addEventListener('abort', () => reject(new Error('Upload aborted')));

            xhr.open('PUT', presignedUrl);
            xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
            xhr.send(file);
        });
    }

    async deleteObject(key) {
        const path = `/${this.settings.bucket}/${this.awsUriEncode(key).replace(/%2F/g, '/')}`;
        const { headers } = await this.signRequest('DELETE', path);
        const url = `${this.endpoint}${path}`;

        const response = await fetch(url, { method: 'DELETE', headers });
        if (!response.ok) throw new Error(`Delete failed: ${response.status}`);
        return true;
    }

    // 复制对象到另一个存储桶
    async copyObject(sourceKey, targetBucket, targetKey) {
        const path = `/${targetBucket}/${this.awsUriEncode(targetKey).replace(/%2F/g, '/')}`;
        const headers = {
            'x-amz-copy-source': `/${this.settings.bucket}/${sourceKey}`
        };
        const { headers: signedHeaders } = await this.signRequest('PUT', path, {}, headers);
        const url = `${this.endpoint}${path}`;

        const response = await fetch(url, { method: 'PUT', headers: signedHeaders });
        if (!response.ok) throw new Error(`Copy failed: ${response.status}`);
        return true;
    }

    // 获取对象元数据（用于 EXIF）
    async headObject(key) {
        const path = `/${this.settings.bucket}/${this.awsUriEncode(key).replace(/%2F/g, '/')}`;
        const { headers } = await this.signRequest('HEAD', path);
        const url = `${this.endpoint}${path}`;

        const response = await fetch(url, { method: 'HEAD', headers });
        if (!response.ok) throw new Error(`Head failed: ${response.status}`);

        return {
            contentType: response.headers.get('content-type'),
            contentLength: response.headers.get('content-length'),
            lastModified: response.headers.get('last-modified'),
            etag: response.headers.get('etag'),
        };
    }
}

// ==================== 图片处理工具 ====================
class ImageProcessor {
    // 压缩图片
    static async compress(file, quality = 80, maxWidth = 1920, maxHeight = 1920) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            const url = URL.createObjectURL(file);

            img.onload = () => {
                URL.revokeObjectURL(url);

                let { width, height } = img;
                if (width > maxWidth || height > maxHeight) {
                    const ratio = Math.min(maxWidth / width, maxHeight / height);
                    width *= ratio;
                    height *= ratio;
                }

                const canvas = document.createElement('canvas');
                canvas.width = width;
                canvas.height = height;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, width, height);

                canvas.toBlob(
                    (blob) => {
                        if (blob) {
                            const compressedFile = new File([blob], file.name.replace(/\.[^.]+$/, '.jpg'), {
                                type: 'image/jpeg',
                                lastModified: Date.now()
                            });
                            resolve(compressedFile);
                        } else {
                            reject(new Error('Compression failed'));
                        }
                    },
                    'image/jpeg',
                    quality / 100
                );
            };

            img.onerror = () => {
                URL.revokeObjectURL(url);
                reject(new Error('Failed to load image'));
            };

            img.src = url;
        });
    }

    // 添加水印
    static async addWatermark(file, options) {
        const { text, position, opacity, fontSize } = options;
        if (!text) return file;

        return new Promise((resolve, reject) => {
            const img = new Image();
            const url = URL.createObjectURL(file);

            img.onload = () => {
                URL.revokeObjectURL(url);

                const canvas = document.createElement('canvas');
                canvas.width = img.width;
                canvas.height = img.height;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0);

                // 设置水印样式
                ctx.globalAlpha = opacity;
                ctx.fillStyle = 'white';
                ctx.strokeStyle = 'black';
                ctx.lineWidth = 2;
                ctx.font = `bold ${fontSize}px sans-serif`;
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';

                // 计算位置
                let x, y;
                const padding = 20;
                switch (position) {
                    case 'top-left': x = padding + ctx.measureText(text).width / 2; y = padding + fontSize / 2; break;
                    case 'top-right': x = img.width - padding - ctx.measureText(text).width / 2; y = padding + fontSize / 2; break;
                    case 'bottom-left': x = padding + ctx.measureText(text).width / 2; y = img.height - padding - fontSize / 2; break;
                    case 'bottom-right': x = img.width - padding - ctx.measureText(text).width / 2; y = img.height - padding - fontSize / 2; break;
                    case 'center': x = img.width / 2; y = img.height / 2; break;
                    default: x = img.width - padding - ctx.measureText(text).width / 2; y = img.height - padding - fontSize / 2;
                }

                // 绘制水印（描边+填充）
                ctx.strokeText(text, x, y);
                ctx.fillText(text, x, y);

                canvas.toBlob(
                    (blob) => {
                        if (blob) {
                            const watermarkedFile = new File([blob], file.name, {
                                type: file.type,
                                lastModified: Date.now()
                            });
                            resolve(watermarkedFile);
                        } else {
                            reject(new Error('Watermark failed'));
                        }
                    },
                    file.type,
                    0.95
                );
            };

            img.onerror = () => {
                URL.revokeObjectURL(url);
                reject(new Error('Failed to load image'));
            };

            img.src = url;
        });
    }

    // 读取 EXIF 信息
    static async readExif(file) {
        return new Promise((resolve) => {
            const reader = new FileReader();
            reader.onload = (e) => {
                const view = new DataView(e.target.result);
                const exif = {};

                // 检查 JPEG 标记
                if (view.getUint16(0) !== 0xFFD8) {
                    resolve(null);
                    return;
                }

                let offset = 2;
                while (offset < view.byteLength) {
                    const marker = view.getUint16(offset);
                    if (marker === 0xFFD9) break; // EOI
                    if (marker === 0xFFE1) { // APP1 (EXIF)
                        const length = view.getUint16(offset + 2);
                        const exifOffset = offset + 4;
                        const exifStr = String.fromCharCode(
                            ...new Uint8Array(e.target.result, exifOffset, 6)
                        );
                        if (exifStr === 'Exif\x00\x00') {
                            const tiffOffset = exifOffset + 6;
                            const isLittleEndian = view.getUint16(tiffOffset) === 0x4949;
                            const ifdOffset = view.getUint32(tiffOffset + 4, isLittleEndian);

                            // 读取 IFD0
                            const ifd0Offset = tiffOffset + ifdOffset;
                            const numEntries = view.getUint16(ifd0Offset, isLittleEndian);

                            for (let i = 0; i < numEntries; i++) {
                                const entryOffset = ifd0Offset + 2 + i * 12;
                                const tag = view.getUint16(entryOffset, isLittleEndian);
                                const type = view.getUint16(entryOffset + 2, isLittleEndian);
                                const count = view.getUint32(entryOffset + 4, isLittleEndian);
                                const valueOffset = view.getUint32(entryOffset + 8, isLittleEndian);

                                const tagNames = {
                                    0x010F: 'make',
                                    0x0110: 'model',
                                    0x0112: 'orientation',
                                    0x011A: 'xResolution',
                                    0x011B: 'yResolution',
                                    0x0128: 'resolutionUnit',
                                    0x0131: 'software',
                                    0x0132: 'dateTime',
                                    0x0213: 'YCbCrPositioning',
                                    0x8298: 'copyright',
                                    0x8769: 'exifIfdPointer',
                                    0x8825: 'gpsInfoIfdPointer',
                                };

                                if (tagNames[tag]) {
                                    if (type === 2) { // ASCII
                                        const strLen = count > 4 ? count : 4;
                                        const valOffset = count > 4 ? tiffOffset + valueOffset : entryOffset + 8;
                                        const chars = [];
                                        for (let j = 0; j < strLen - 1; j++) {
                                            const char = view.getUint8(valOffset + j);
                                            if (char === 0) break;
                                            chars.push(char);
                                        }
                                        exif[tagNames[tag]] = String.fromCharCode(...chars);
                                    } else if (type === 3) { // SHORT
                                        exif[tagNames[tag]] = count > 1 ? valueOffset : view.getUint16(entryOffset + 8, isLittleEndian);
                                    } else {
                                        exif[tagNames[tag]] = valueOffset;
                                    }
                                }
                            }
                        }
                        break;
                    }
                    const length = view.getUint16(offset + 2);
                    offset += 2 + length;
                }

                resolve(Object.keys(exif).length > 0 ? exif : null);
            };
            reader.readAsArrayBuffer(file.slice(0, 65536));
        });
    }
}

// ==================== 图片预览弹窗 ====================
class ImagePreviewModal extends Modal {
    constructor(app, url, fileName) {
        super(app);
        this.url = url;
        this.fileName = fileName;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('bitiful-preview-modal');

        const imgContainer = contentEl.createDiv('bitiful-preview-container');
        const img = imgContainer.createEl('img', {
            attr: { src: this.url, alt: this.fileName }
        });
        img.style.maxWidth = '90vw';
        img.style.maxHeight = '80vh';
        img.style.objectFit = 'contain';

        const info = contentEl.createEl('div', { cls: 'bitiful-preview-info' });
        info.setText(this.fileName);

        this.modalEl.addEventListener('click', (e) => {
            if (e.target === this.modalEl || e.target === contentEl) {
                this.close();
            }
        });
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}

// ==================== EXIF 信息弹窗 ====================
class ExifModal extends Modal {
    constructor(app, exifData, fileName) {
        super(app);
        this.exifData = exifData;
        this.fileName = fileName;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        this.titleEl.setText(`📷 EXIF 信息: ${this.fileName}`);

        if (!this.exifData) {
            contentEl.createEl('p', { text: '该图片没有 EXIF 信息' });
            return;
        }

        const table = contentEl.createEl('table', { cls: 'bitiful-exif-table' });
        const tbody = table.createEl('tbody');

        const labels = {
            make: '相机品牌',
            model: '相机型号',
            dateTime: '拍摄时间',
            orientation: '方向',
            xResolution: 'X 分辨率',
            yResolution: 'Y 分辨率',
            resolutionUnit: '分辨率单位',
            software: '软件',
            copyright: '版权',
        };

        for (const [key, value] of Object.entries(this.exifData)) {
            if (key === 'exifIfdPointer' || key === 'gpsInfoIfdPointer') continue;
            const row = tbody.createEl('tr');
            row.createEl('td', { text: labels[key] || key, cls: 'bitiful-exif-label' });
            row.createEl('td', { text: String(value), cls: 'bitiful-exif-value' });
        }
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}

// ==================== 上传进度弹窗 ====================
class UploadProgressModal extends Modal {
    constructor(app) {
        super(app);
        this.progressItems = new Map();
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('bitiful-upload-modal');
        this.titleEl.setText('⬆️ 上传进度');
        this.listEl = contentEl.createDiv('bitiful-upload-list');
    }

    addFile(fileName) {
        const itemEl = this.listEl.createDiv('bitiful-upload-item');
        itemEl.createEl('div', { cls: 'bitiful-upload-filename', text: fileName });
        const barEl = itemEl.createDiv('bitiful-progress-bar');
        const fillEl = barEl.createDiv('bitiful-progress-fill');
        fillEl.style.width = '0%';
        const percentEl = itemEl.createEl('div', { cls: 'bitiful-upload-percent', text: '0%' });

        this.progressItems.set(fileName, { fillEl, percentEl });
        return itemEl;
    }

    updateProgress(fileName, percent) {
        const item = this.progressItems.get(fileName);
        if (item) {
            item.fillEl.style.width = `${percent}%`;
            item.percentEl.setText(`${percent}%`);
        }
    }

    completeFile(fileName, success) {
        const item = this.progressItems.get(fileName);
        if (item) {
            item.percentEl.setText(success ? '✅' : '❌');
            item.fillEl.style.width = '100%';
            if (!success) {
                item.fillEl.style.background = '#ff5252';
            }
        }
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}

// ==================== 存储桶间复制弹窗 ====================
class CopyBucketModal extends Modal {
    constructor(app, plugin, sourceFiles) {
        super(app);
        this.plugin = plugin;
        this.sourceFiles = sourceFiles;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        this.titleEl.setText('📋 复制到其他存储桶');

        contentEl.createEl('p', {
            text: `将 ${this.sourceFiles.length} 个文件复制到目标存储桶`,
            cls: 'bitiful-modal-desc'
        });

        // 目标存储桶设置
        const form = contentEl.createDiv('bitiful-form');

        const bucketRow = form.createDiv('bitiful-form-row');
        bucketRow.createEl('label', { text: '目标 Bucket:' });
        const bucketInput = bucketRow.createEl('input', {
            attr: { type: 'text', placeholder: 'target-bucket', value: this.plugin.settings.targetBucket || '' }
        });

        const endpointRow = form.createDiv('bitiful-form-row');
        endpointRow.createEl('label', { text: '目标 Endpoint:' });
        const endpointInput = endpointRow.createEl('input', {
            attr: { type: 'text', placeholder: 'https://s3.bitiful.net', value: this.plugin.settings.targetEndpoint || this.plugin.settings.endpoint }
        });

        const regionRow = form.createDiv('bitiful-form-row');
        regionRow.createEl('label', { text: '目标 Region:' });
        const regionInput = regionRow.createEl('input', {
            attr: { type: 'text', placeholder: 'cn-east-1', value: this.plugin.settings.targetRegion || 'cn-east-1' }
        });

        const prefixRow = form.createDiv('bitiful-form-row');
        prefixRow.createEl('label', { text: '目标路径前缀:' });
        const prefixInput = prefixRow.createEl('input', {
            attr: { type: 'text', placeholder: 'copied/', value: '' }
        });

        const btnContainer = contentEl.createDiv('bitiful-modal-buttons');

        const cancelBtn = btnContainer.createEl('button', { text: '取消' });
        cancelBtn.addEventListener('click', () => this.close());

        const confirmBtn = btnContainer.createEl('button', {
            text: '开始复制',
            attr: { style: 'background: var(--text-accent); color: white;' }
        });
        confirmBtn.addEventListener('click', async () => {
            const targetBucket = bucketInput.value.trim();
            const targetEndpoint = endpointInput.value.trim() || this.plugin.settings.endpoint;
            const targetRegion = regionInput.value.trim() || this.plugin.settings.region;
            const prefix = prefixInput.value.trim();

            if (!targetBucket) {
                new Notice('❌ 请输入目标 Bucket 名称');
                return;
            }

            // 保存设置
            this.plugin.settings.targetBucket = targetBucket;
            this.plugin.settings.targetEndpoint = targetEndpoint;
            this.plugin.settings.targetRegion = targetRegion;
            await this.plugin.saveSettings();

            this.close();
            await this.doCopy(targetBucket, targetEndpoint, targetRegion, prefix);
        });
    }

    async doCopy(targetBucket, targetEndpoint, targetRegion, prefix) {
        const s3 = new S3Client(this.plugin.settings);
        let success = 0, fail = 0;

        new Notice(`📋 开始复制 ${this.sourceFiles.length} 个文件...`, 5000);

        for (const file of this.sourceFiles) {
            const targetKey = prefix ? prefix + file.name : file.path;
            try {
                await s3.copyObject(file.path, targetBucket, targetKey);
                success++;
            } catch (e) {
                console.error(`复制失败 ${file.name}:`, e);
                fail++;
            }
        }

        new Notice(`📋 复制完成: ${success} 成功, ${fail} 失败`);
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}

// ==================== 设置面板 ====================
class BitifulSettingTab extends PluginSettingTab {
    constructor(app, plugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display() {
        const { containerEl } = this;
        containerEl.empty();

        containerEl.createEl('h2', { text: '🌈 缤纷云助手设置' });

        // S3 凭证
        const credSection = containerEl.createDiv('bitiful-settings-section');
        credSection.createEl('h3', { text: 'S3 API 配置' });

        new Setting(credSection)
            .setName('Access Key ID')
            .setDesc('缤纷云控制台创建的子账户 Access Key')
            .addText(text => text
                .setPlaceholder('AKIAXXXXXXXXXXXXXXXX')
                .setValue(this.plugin.settings.accessKeyId)
                .onChange(async (value) => {
                    this.plugin.settings.accessKeyId = value.trim();
                    await this.plugin.saveSettings();
                }));

        new Setting(credSection)
            .setName('Secret Access Key')
            .setDesc('缤纷云控制台创建的子账户 Secret Key')
            .addText(text => {
                text.inputEl.type = 'password';
                text.setPlaceholder('xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx')
                    .setValue(this.plugin.settings.secretAccessKey)
                    .onChange(async (value) => {
                        this.plugin.settings.secretAccessKey = value.trim();
                        await this.plugin.saveSettings();
                    });
            });

        new Setting(credSection)
            .setName('Bucket 名称')
            .setDesc('缤纷云存储桶名称')
            .addText(text => text
                .setPlaceholder('my-bucket')
                .setValue(this.plugin.settings.bucket)
                .onChange(async (value) => {
                    this.plugin.settings.bucket = value.trim();
                    await this.plugin.saveSettings();
                }));

        new Setting(credSection)
            .setName('Endpoint')
            .setDesc('S3 端点地址（不要带尾部斜杠）')
            .addText(text => text
                .setPlaceholder('https://s3.bitiful.net')
                .setValue(this.plugin.settings.endpoint)
                .onChange(async (value) => {
                    this.plugin.settings.endpoint = value.trim().replace(/\/$/, '') || 'https://s3.bitiful.net';
                    await this.plugin.saveSettings();
                }));

        new Setting(credSection)
            .setName('Region')
            .setDesc('区域代码')
            .addText(text => text
                .setPlaceholder('cn-east-1')
                .setValue(this.plugin.settings.region)
                .onChange(async (value) => {
                    this.plugin.settings.region = value.trim() || 'cn-east-1';
                    await this.plugin.saveSettings();
                }));

        new Setting(credSection)
            .setName('测试连接')
            .setDesc('验证 S3 配置是否正确')
            .addButton(btn => btn
                .setButtonText('测试连接')
                .setCta()
                .onClick(async () => {
                    const resultEl = credSection.createDiv('bitiful-test-result');
                    try {
                        const s3 = new S3Client(this.plugin.settings);
                        await s3.listObjects('', '/', 1);
                        resultEl.addClass('success');
                        resultEl.setText('✅ 连接成功！');
                    } catch (e) {
                        resultEl.addClass('error');
                        resultEl.setText(`❌ 连接失败: ${e.message}`);
                    }
                    setTimeout(() => resultEl.remove(), 8000);
                }));

        // 高级配置
        const advancedSection = containerEl.createDiv('bitiful-settings-section');
        advancedSection.createEl('h3', { text: '高级配置' });

        new Setting(advancedSection)
            .setName('自定义域名')
            .setDesc('如果绑定了自定义 CDN 域名，请填写')
            .addText(text => text
                .setPlaceholder('https://cdn.example.com')
                .setValue(this.plugin.settings.customDomain)
                .onChange(async (value) => {
                    this.plugin.settings.customDomain = value.trim();
                    await this.plugin.saveSettings();
                }));

        new Setting(advancedSection)
            .setName('上传目录前缀')
            .setDesc('文件默认上传到该目录下')
            .addText(text => text
                .setPlaceholder('obsidian/')
                .setValue(this.plugin.settings.uploadPathPrefix)
                .onChange(async (value) => {
                    this.plugin.settings.uploadPathPrefix = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(advancedSection)
            .setName('自动重命名')
            .setDesc('上传时自动按时间戳重命名')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.autoRename)
                .onChange(async (value) => {
                    this.plugin.settings.autoRename = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(advancedSection)
            .setName('搜索范围')
            .setDesc('搜索时查找全部文件还是仅当前目录')
            .addDropdown(drop => drop
                .addOption('true', '搜索全部文件')
                .addOption('false', '仅搜索当前目录')
                .setValue(String(this.plugin.settings.searchAllFiles))
                .onChange(async (value) => {
                    this.plugin.settings.searchAllFiles = value === 'true';
                    await this.plugin.saveSettings();
                }));

        new Setting(advancedSection)
            .setName('启用图片预览')
            .setDesc('在侧边栏显示图片缩略图')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.enableImagePreview)
                .onChange(async (value) => {
                    this.plugin.settings.enableImagePreview = value;
                    await this.plugin.saveSettings();
                }));

        // 图片压缩
        const compressSection = containerEl.createDiv('bitiful-settings-section');
        compressSection.createEl('h3', { text: '🖼️ 图片压缩' });

        new Setting(compressSection)
            .setName('上传时自动压缩图片')
            .setDesc('压缩为 JPEG 格式，大幅减少文件体积')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.enableImageCompress)
                .onChange(async (value) => {
                    this.plugin.settings.enableImageCompress = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(compressSection)
            .setName('压缩质量')
            .setDesc('1-100，数值越高质量越好但文件越大（推荐 80）')
            .addSlider(slider => slider
                .setLimits(1, 100, 1)
                .setValue(this.plugin.settings.compressQuality)
                .setDynamicTooltip()
                .onChange(async (value) => {
                    this.plugin.settings.compressQuality = value;
                    await this.plugin.saveSettings();
                }));

        // 水印设置
        const watermarkSection = containerEl.createDiv('bitiful-settings-section');
        watermarkSection.createEl('h3', { text: '💧 图片水印' });

        new Setting(watermarkSection)
            .setName('启用图片水印')
            .setDesc('上传图片时自动添加水印（默认关闭）')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.enableWatermark)
                .onChange(async (value) => {
                    this.plugin.settings.enableWatermark = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(watermarkSection)
            .setName('水印文字')
            .setDesc('留空则使用默认（Obsidian 用户名）')
            .addText(text => text
                .setPlaceholder('your watermark')
                .setValue(this.plugin.settings.watermarkText)
                .onChange(async (value) => {
                    this.plugin.settings.watermarkText = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(watermarkSection)
            .setName('水印位置')
            .setDesc('水印在图片上的位置')
            .addDropdown(drop => drop
                .addOption('top-left', '左上角')
                .addOption('top-right', '右上角')
                .addOption('bottom-left', '左下角')
                .addOption('bottom-right', '右下角')
                .addOption('center', '居中')
                .setValue(this.plugin.settings.watermarkPosition)
                .onChange(async (value) => {
                    this.plugin.settings.watermarkPosition = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(watermarkSection)
            .setName('水印透明度')
            .setDesc('0.1-1.0，数值越小越透明')
            .addSlider(slider => slider
                .setLimits(0.1, 1, 0.1)
                .setValue(this.plugin.settings.watermarkOpacity)
                .setDynamicTooltip()
                .onChange(async (value) => {
                    this.plugin.settings.watermarkOpacity = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(watermarkSection)
            .setName('水印字体大小')
            .setDesc('水印文字大小（像素）')
            .addSlider(slider => slider
                .setLimits(12, 72, 1)
                .setValue(this.plugin.settings.watermarkFontSize)
                .setDynamicTooltip()
                .onChange(async (value) => {
                    this.plugin.settings.watermarkFontSize = value;
                    await this.plugin.saveSettings();
                }));

        // 自动同步
        const syncSection = containerEl.createDiv('bitiful-settings-section');
        syncSection.createEl('h3', { text: '🔄 自动同步本地文件夹' });

        new Setting(syncSection)
            .setName('启用自动同步')
            .setDesc('监控本地文件夹，新文件自动上传到缤纷云')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.autoSyncEnabled)
                .onChange(async (value) => {
                    this.plugin.settings.autoSyncEnabled = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(syncSection)
            .setName('同步文件夹路径')
            .setDesc('本地需要同步的文件夹绝对路径（如 /Users/xxx/Pictures）')
            .addText(text => text
                .setPlaceholder('/path/to/folder')
                .setValue(this.plugin.settings.autoSyncFolder)
                .onChange(async (value) => {
                    this.plugin.settings.autoSyncFolder = value.trim();
                    await this.plugin.saveSettings();
                }));

        syncSection.createEl('div', {
            cls: 'bitiful-setting-desc',
            text: '⚠️ 注意：自动同步功能需要 Obsidian 保持运行，且仅支持桌面端。'
        });

        // 链接模板
        const templateSection = containerEl.createDiv('bitiful-settings-section');
        templateSection.createEl('h3', { text: '🔗 链接模板' });

        new Setting(templateSection)
            .setName('自定义链接模板')
            .setDesc('可用变量: {{filename}}, {{url}}, {{ext}}, {{basename}}')
            .addText(text => text
                .setPlaceholder('![{{filename}}]({{url}})')
                .setValue(this.plugin.settings.linkTemplate)
                .onChange(async (value) => {
                    this.plugin.settings.linkTemplate = value;
                    await this.plugin.saveSettings();
                }));

        templateSection.createEl('div', {
            cls: 'bitiful-setting-desc',
            text: '示例: ![{{basename}}]({{url}}) 或 <img src="{{url}}" alt="{{filename}}" />'
        });

        // 目标存储桶（用于复制）
        const targetSection = containerEl.createDiv('bitiful-settings-section');
        targetSection.createEl('h3', { text: '📋 目标存储桶（复制用）' });

        new Setting(targetSection)
            .setName('目标 Bucket')
            .setDesc('存储桶间复制的目标 Bucket')
            .addText(text => text
                .setPlaceholder('target-bucket')
                .setValue(this.plugin.settings.targetBucket)
                .onChange(async (value) => {
                    this.plugin.settings.targetBucket = value.trim();
                    await this.plugin.saveSettings();
                }));

        new Setting(targetSection)
            .setName('目标 Endpoint')
            .setDesc('目标存储桶的 Endpoint（留空则使用当前）')
            .addText(text => text
                .setPlaceholder('https://s3.bitiful.net')
                .setValue(this.plugin.settings.targetEndpoint)
                .onChange(async (value) => {
                    this.plugin.settings.targetEndpoint = value.trim();
                    await this.plugin.saveSettings();
                }));

        new Setting(targetSection)
            .setName('目标 Region')
            .setDesc('目标存储桶的 Region')
            .addText(text => text
                .setPlaceholder('cn-east-1')
                .setValue(this.plugin.settings.targetRegion)
                .onChange(async (value) => {
                    this.plugin.settings.targetRegion = value.trim();
                    await this.plugin.saveSettings();
                }));

        // 使用帮助
        const helpSection = containerEl.createDiv('bitiful-settings-section');
        helpSection.createEl('h3', { text: '使用帮助' });

        const helpText = helpSection.createEl('div', { cls: 'bitiful-setting-desc' });
        helpText.innerHTML = `
            <p><strong>如何获取 S3 凭证：</strong></p>
            <ol>
                <li>登录 <a href="https://console.bitiful.com/">缤纷云控制台</a></li>
                <li>进入「Bucket 设置」页面</li>
                <li>创建子账户并分配权限（ListBucket、GetObject、PutObject、DeleteObject）</li>
                <li>复制 Access Key 和 Secret Key 到上方配置</li>
            </ol>
            <p><strong>快捷键：</strong>Ctrl+Shift+P → 搜索「缤纷云」查看所有命令</p>
        `;
    }
}

// ==================== 侧边栏视图 ====================
class BitifulView extends ItemView {
    constructor(leaf, plugin) {
        super(leaf);
        this.plugin = plugin;
        this.currentPrefix = this.plugin.settings.uploadPathPrefix || '';
        this.fileTree = [];
        this.allFilesCache = [];
        this.isLoadingAll = false;
        this.selectedFiles = new Set();
        this.recentFiles = [];
        this.usageStats = null;
        this.syncWatcher = null;
        this.apiCallCount = 0;
        this.totalTraffic = 0;
    }

    getViewType() { return VIEW_TYPE_BITIFUL; }
    getDisplayText() { return '🌈 缤纷云'; }
    getIcon() { return 'image'; }

    async onOpen() {
        this.containerEl.empty();
        this.containerEl.addClass('bitiful-sidebar');

        if (!this.plugin.settings.accessKeyId || !this.plugin.settings.secretAccessKey || !this.plugin.settings.bucket) {
            this.renderSetupGuide();
            return;
        }

        this.renderSidebar();
        await this.loadFiles();

        // 启动自动同步
        if (this.plugin.settings.autoSyncEnabled && this.plugin.settings.autoSyncFolder) {
            this.startAutoSync();
        }
    }

    onClose() {
        if (this.syncWatcher) {
            clearInterval(this.syncWatcher);
            this.syncWatcher = null;
        }
    }

    renderSetupGuide() {
        const guide = this.containerEl.createDiv('bitiful-empty');
        guide.innerHTML = `
            <div class="bitiful-empty-icon">⚙️</div>
            <h3>请先配置缤纷云</h3>
            <p>进入设置 → 缤纷云助手</p>
            <p>填写 S3 API 凭证后即可使用</p>
        `;
    }

    renderSidebar() {
        this.containerEl.empty();

        const header = this.containerEl.createDiv('bitiful-header');
        header.createEl('h3', { text: '🌈 缤纷云' });

        const refreshBtn = header.createEl('button', { cls: 'bitiful-btn', text: '🔄' });
        refreshBtn.title = '刷新';
        refreshBtn.addEventListener('click', () => this.loadFiles());

        // ===== 使用情况概览（参照官方控制台）=====
        this.usageEl = this.containerEl.createDiv('bitiful-usage');
        this.renderUsageOverview();

        // ===== 容量分布饼图区域 =====
        this.distributionEl = this.containerEl.createDiv('bitiful-distribution');
        this.renderDistribution();

        // ===== 最近文件 =====
        this.recentEl = this.containerEl.createDiv('bitiful-recent');
        this.renderRecentFiles();

        // ===== 搜索框 =====
        this.searchInput = this.containerEl.createEl('input', {
            cls: 'bitiful-search-box',
            attr: { placeholder: '🔍 搜索文件...', type: 'text' }
        });
        this.searchInput.addEventListener('input', (e) => this.handleSearch(e.target.value));

        // ===== 工具栏 =====
        const toolbar = this.containerEl.createDiv('bitiful-toolbar');

        const uploadBtn = toolbar.createEl('button', { cls: 'bitiful-btn primary', text: '⬆️ 上传' });
        uploadBtn.addEventListener('click', () => this.handleUploadClick());

        const newFolderBtn = toolbar.createEl('button', { cls: 'bitiful-btn', text: '📁 新建' });
        newFolderBtn.addEventListener('click', () => this.handleNewFolder());

        const sortBtn = toolbar.createEl('button', { cls: 'bitiful-btn', text: '⇅ 排序' });
        sortBtn.addEventListener('click', () => this.showSortMenu(sortBtn));

        const batchBtn = toolbar.createEl('button', { cls: 'bitiful-btn', text: '☐ 批量' });
        batchBtn.addEventListener('click', () => this.toggleBatchMode());
        this.batchBtn = batchBtn;

        const copyBucketBtn = toolbar.createEl('button', { cls: 'bitiful-btn', text: '📋 复制桶' });
        copyBucketBtn.addEventListener('click', () => this.showCopyBucketModal());

        // ===== 面包屑 =====
        this.breadcrumbEl = this.containerEl.createDiv('bitiful-breadcrumb');
        this.renderBreadcrumb();

        // ===== 批量操作栏 =====
        this.batchBar = this.containerEl.createDiv('bitiful-batch-bar');
        this.batchBar.style.display = 'none';
        this.renderBatchBar();

        // ===== 文件树 =====
        this.treeContainer = this.containerEl.createDiv('bitiful-file-tree');

        // ===== 拖拽上传 =====
        this.dropZone = this.containerEl.createDiv('bitiful-drop-zone');
        this.dropZone.innerHTML = '📎 拖拽文件到此处上传';
        this.setupDragDrop();

        this.setupPasteHandler();
    }

    // ===== 使用情况概览 =====
    renderUsageOverview() {
        this.usageEl.empty();
        // 概览区域保留为空或显示简单提示，容量分布单独在 renderDistribution 中展示
        this.usageEl.style.display = 'none';
    }

    // ===== 容量分布 =====
    renderDistribution() {
        this.distributionEl.empty();
        if (!this.usageStats) {
            this.distributionEl.createEl('div', {
                cls: 'bitiful-usage-loading',
                text: '⏳ 正在统计使用情况...'
            });
            return;
        }

        const stats = this.usageStats;
        this.distributionEl.addClass('bitiful-distribution-section');

        this.distributionEl.createEl('div', { cls: 'bitiful-distribution-title', text: '📊 容量分布' });

        // 总容量显示（免费50G）
        const FREE_LIMIT = 50 * 1024 * 1024 * 1024; // 50GB
        const usedPercent = Math.min((stats.totalSize / FREE_LIMIT) * 100, 100).toFixed(1);
        const isNearLimit = stats.totalSize > FREE_LIMIT * 0.9;
        const isOverLimit = stats.totalSize > FREE_LIMIT;

        const totalEl = this.distributionEl.createEl('div', {
            cls: 'bitiful-dist-row',
            attr: { style: 'margin-bottom:12px; padding:8px; background:var(--background-primary); border-radius:6px;' }
        });
        totalEl.createEl('span', { cls: 'bitiful-dist-dot', attr: { style: 'background:#00BCD4' } });
        totalEl.createEl('span', { cls: 'bitiful-dist-name', text: '总计', attr: { style: 'font-weight:600;color:var(--text-normal);' } });
        totalEl.createEl('span', { cls: 'bitiful-dist-percent', text: `${usedPercent}%`, attr: { style: `font-weight:600; color:${isOverLimit ? '#ff5252' : isNearLimit ? '#FF9800' : 'var(--text-normal)'};` } });
        const totalBarContainer = totalEl.createDiv('bitiful-dist-bar-container');
        const totalBar = totalBarContainer.createDiv('bitiful-dist-bar');
        totalBar.style.width = `${usedPercent}%`;
        totalBar.style.background = isOverLimit ? '#ff5252' : isNearLimit ? '#FF9800' : '#00BCD4';
        totalEl.createEl('span', {
            cls: 'bitiful-dist-size',
            text: `${this.formatFileSize(stats.totalSize)} / 50G`,
            attr: { style: `font-weight:600;color:${isOverLimit ? '#ff5252' : 'var(--text-normal)'};` }
        });

        // 免费容量提示
        const freeTip = this.distributionEl.createEl('div', {
            attr: { style: 'font-size:11px; color:var(--text-muted); margin-bottom:10px; padding-left:4px;' }
        });
        const remain = FREE_LIMIT - stats.totalSize;
        if (isOverLimit) {
            freeTip.setText(`⚠️ 已超出免费容量 ${this.formatFileSize(stats.totalSize - FREE_LIMIT)}`);
            freeTip.style.color = '#ff5252';
        } else if (isNearLimit) {
            freeTip.setText(`⚠️ 免费容量即将用完，剩余 ${this.formatFileSize(remain)}`);
            freeTip.style.color = '#FF9800';
        } else {
            freeTip.setText(`✅ 免费容量 50G，剩余 ${this.formatFileSize(remain)}`);
        }

        // 文件数量统计
        const countEl = this.distributionEl.createEl('div', {
            attr: { style: 'font-size:11px; color:var(--text-muted); margin-bottom:10px; padding-left:4px;' }
        });
        countEl.setText(`共 ${stats.fileCount} 个文件，${stats.folderCount} 个文件夹`);

        const typeDist = this.distributionEl.createDiv('bitiful-type-dist');
        const types = [
            { name: '图片', count: stats.imageCount, size: stats.imageSize, color: '#4CAF50' },
            { name: '视频', count: stats.videoCount, size: stats.videoSize, color: '#2196F3' },
            { name: '音频', count: stats.audioCount, size: stats.audioSize, color: '#FF9800' },
            { name: '文档', count: stats.docCount, size: stats.docSize, color: '#9C27B0' },
            { name: '其他', count: stats.otherCount, size: stats.otherSize, color: '#607D8B' },
        ];

        const totalSize = stats.totalSize || 1;
        types.forEach(type => {
            if (type.count === 0) return;
            const row = typeDist.createDiv('bitiful-dist-row');
            const percent = ((type.size / totalSize) * 100).toFixed(1);
            row.createEl('span', { cls: 'bitiful-dist-dot', attr: { style: `background:${type.color}` } });
            row.createEl('span', { cls: 'bitiful-dist-name', text: type.name });
            row.createEl('span', { cls: 'bitiful-dist-percent', text: `${percent}%` });
            const barContainer = row.createDiv('bitiful-dist-bar-container');
            const bar = barContainer.createDiv('bitiful-dist-bar');
            bar.style.width = `${percent}%`;
            bar.style.background = type.color;
            row.createEl('span', { cls: 'bitiful-dist-size', text: this.formatFileSize(type.size) });
        });
    }

    // 格式化数字
    formatNumber(num) {
        if (num >= 1000000) return (num / 1000000).toFixed(1) + ' M';
        if (num >= 1000) return (num / 1000).toFixed(1) + ' K';
        return String(num);
    }

    // 估算消费
    estimateCost(totalSize, requestCount) {
        // 存储费用
        let storageCost = 0;
        for (const tier of BITIFUL_PRICES.storage) {
            if (totalSize <= tier.limit) {
                storageCost = totalSize * tier.price * 24; // 每日
                break;
            }
        }

        // 请求费用
        let requestCost = 0;
        for (const tier of BITIFUL_PRICES.request) {
            if (requestCount <= tier.limit) {
                requestCost = requestCount * tier.price;
                break;
            }
        }

        return storageCost + requestCost;
    }

    // ===== 最近文件 =====
    renderRecentFiles() {
        this.recentEl.empty();
        if (this.recentFiles.length === 0) return;

        this.recentEl.createEl('div', { cls: 'bitiful-recent-title', text: '🕐 最近使用' });
        const list = this.recentEl.createDiv('bitiful-recent-list');

        this.recentFiles.slice(0, this.plugin.settings.maxRecentFiles).forEach(file => {
            const item = list.createDiv('bitiful-recent-item');
            const icon = IMAGE_EXTS.includes(file.ext) ? '🖼️' : '📎';
            item.createEl('span', { text: icon });
            item.createEl('span', { cls: 'bitiful-recent-name', text: file.name, attr: { title: file.path } });
            item.addEventListener('click', () => {
                const dir = file.path.substring(0, file.path.lastIndexOf('/') + 1);
                this.navigateTo(dir);
            });
        });
    }

    addToRecent(file) {
        this.recentFiles = this.recentFiles.filter(f => f.path !== file.path);
        this.recentFiles.unshift(file);
        if (this.recentFiles.length > this.plugin.settings.maxRecentFiles * 2) {
            this.recentFiles = this.recentFiles.slice(0, this.plugin.settings.maxRecentFiles * 2);
        }
        this.renderRecentFiles();
    }

    // ===== 批量操作 =====
    toggleBatchMode() {
        this.batchMode = !this.batchMode;
        this.selectedFiles.clear();

        if (this.batchMode) {
            this.batchBar.style.display = 'flex';
            this.batchBtn.addClass('active');
            this.batchBtn.setText('☑ 完成');
        } else {
            this.batchBar.style.display = 'none';
            this.batchBtn.removeClass('active');
            this.batchBtn.setText('☐ 批量');
        }

        this.renderFileTree();
    }

    renderBatchBar() {
        this.batchBar.empty();
        this.batchBar.createEl('span', { cls: 'bitiful-batch-count', text: '已选 0 个' });

        const copyBtn = this.batchBar.createEl('button', { cls: 'bitiful-btn', text: '📝 复制 Markdown' });
        copyBtn.addEventListener('click', () => this.batchCopy('markdown'));

        const insertBtn = this.batchBar.createEl('button', { cls: 'bitiful-btn', text: '⬇️ 插入笔记' });
        insertBtn.addEventListener('click', () => this.batchInsert());

        const deleteBtn = this.batchBar.createEl('button', { cls: 'bitiful-btn danger', text: '🗑️ 删除' });
        deleteBtn.addEventListener('click', () => this.batchDelete());
    }

    updateBatchCount() {
        const countEl = this.batchBar.querySelector('.bitiful-batch-count');
        if (countEl) countEl.setText(`已选 ${this.selectedFiles.size} 个`);
    }

    async batchCopy(format) {
        if (this.selectedFiles.size === 0) {
            new Notice('请先选择文件');
            return;
        }

        const s3 = new S3Client(this.plugin.settings);
        const links = [];

        for (const path of this.selectedFiles) {
            const file = this.allFilesCache.find(f => f.path === path) || this.fileTree.find(f => f.path === path);
            if (!file) continue;

            const url = s3.getPublicUrl(file.path);
            const link = this.applyTemplate(file, url);
            links.push(link);
        }

        await navigator.clipboard.writeText(links.join('\n'));
        new Notice(`✅ 已复制 ${links.length} 个文件的链接`);
    }

    async batchInsert() {
        if (this.selectedFiles.size === 0) {
            new Notice('请先选择文件');
            return;
        }

        const view = this.getActiveMarkdownView();
        if (!view) {
            new Notice('❌ 请先打开一个笔记');
            return;
        }

        const s3 = new S3Client(this.plugin.settings);
        const links = [];

        for (const path of this.selectedFiles) {
            const file = this.allFilesCache.find(f => f.path === path) || this.fileTree.find(f => f.path === path);
            if (!file) continue;

            const url = s3.getPublicUrl(file.path);
            const link = this.applyTemplate(file, url);
            links.push(link);
        }

        view.editor.replaceSelection(links.join('\n\n'));
        new Notice(`✅ 已插入 ${links.length} 个文件`);
    }

    async batchDelete() {
        if (this.selectedFiles.size === 0) {
            new Notice('请先选择文件');
            return;
        }

        const modal = new Modal(this.app);
        modal.titleEl.setText('确认批量删除');
        modal.contentEl.setText(`确定要删除选中的 ${this.selectedFiles.size} 个文件吗？此操作不可恢复。`);

        const btnContainer = modal.contentEl.createDiv();
        btnContainer.style.cssText = 'display: flex; gap: 10px; margin-top: 20px;';

        const cancelBtn = btnContainer.createEl('button', { text: '取消' });
        cancelBtn.addEventListener('click', () => modal.close());

        const confirmBtn = btnContainer.createEl('button', { text: '删除', attr: { style: 'background: #ff5252; color: white;' } });
        confirmBtn.addEventListener('click', async () => {
            modal.close();
            let success = 0, fail = 0;
            const s3 = new S3Client(this.plugin.settings);

            for (const path of this.selectedFiles) {
                try {
                    await s3.deleteObject(path);
                    success++;
                } catch (e) {
                    fail++;
                }
            }

            new Notice(`🗑️ 删除完成: ${success} 成功, ${fail} 失败`);
            this.selectedFiles.clear();
            this.updateBatchCount();
            await this.loadFiles();
        });

        modal.open();
    }

    // ===== 存储桶间复制 =====
    showCopyBucketModal() {
        const files = this.batchMode && this.selectedFiles.size > 0
            ? Array.from(this.selectedFiles).map(path => this.allFilesCache.find(f => f.path === path) || this.fileTree.find(f => f.path === path)).filter(Boolean)
            : this.fileTree.filter(f => f.type === 'file');

        if (files.length === 0) {
            new Notice('没有可复制的文件');
            return;
        }

        const modal = new CopyBucketModal(this.app, this.plugin, files);
        modal.open();
    }

    // ===== 排序菜单 =====
    showSortMenu(targetEl) {
        const menu = new Menu();
        const sorts = [
            { key: 'name', label: '名称' },
            { key: 'size', label: '大小' },
            { key: 'date', label: '修改时间' }
        ];

        sorts.forEach(sort => {
            menu.addItem((item) => {
                const isActive = this.plugin.settings.sortBy === sort.key;
                item.setTitle(`${isActive ? '✓ ' : ''}按${sort.label}排序`);
                item.onClick(async () => {
                    this.plugin.settings.sortBy = sort.key;
                    await this.plugin.saveSettings();
                    this.renderFileTree();
                });
            });
        });

        menu.addSeparator();

        menu.addItem((item) => {
            const isAsc = this.plugin.settings.sortOrder === 'asc';
            item.setTitle(`${isAsc ? '✓ ' : ''}升序`);
            item.onClick(async () => {
                this.plugin.settings.sortOrder = 'asc';
                await this.plugin.saveSettings();
                this.renderFileTree();
            });
        });

        menu.addItem((item) => {
            const isDesc = this.plugin.settings.sortOrder === 'desc';
            item.setTitle(`${isDesc ? '✓ ' : ''}降序`);
            item.onClick(async () => {
                this.plugin.settings.sortOrder = 'desc';
                await this.plugin.saveSettings();
                this.renderFileTree();
            });
        });

        menu.showAtMouseEvent({ target: targetEl });
    }

    // ===== 笔记内图片反查 =====
    async scanNoteImages() {
        const view = this.getActiveMarkdownView();
        if (!view) {
            new Notice('❌ 请先打开一个笔记');
            return;
        }

        const content = view.editor.getValue();
        const s3 = new S3Client(this.plugin.settings);
        const baseUrl = s3.getPublicUrl('').replace(/\/$/, '');

        const mdRegex = /!\[.*?\]\((.*?)\)/g;
        const htmlRegex = /<img[^>]+src=["'](.*?)["']/g;

        const urls = new Set();
        let match;
        while ((match = mdRegex.exec(content)) !== null) urls.add(match[1]);
        while ((match = htmlRegex.exec(content)) !== null) urls.add(match[1]);

        const bitifulUrls = Array.from(urls).filter(url => url.includes(baseUrl) || url.includes('s3.bitiful.net'));

        if (bitifulUrls.length === 0) {
            new Notice('当前笔记中没有找到缤纷云图片');
            return;
        }

        const keys = bitifulUrls.map(url => {
            try {
                const u = new URL(url);
                const parts = u.pathname.split('/');
                return parts.slice(2).join('/');
            } catch {
                return null;
            }
        }).filter(Boolean);

        this.highlightFiles(keys);
        new Notice(`🔍 找到 ${keys.length} 个缤纷云图片，已在侧边栏高亮`);
    }

    highlightFiles(keys) {
        const fileItems = this.treeContainer.querySelectorAll('.bitiful-file-item');
        fileItems.forEach(item => {
            const path = item.getAttribute('data-path');
            if (keys.includes(path)) {
                item.addClass('highlighted');
                item.scrollIntoView({ behavior: 'smooth', block: 'center' });
            } else {
                item.removeClass('highlighted');
            }
        });
    }

    renderBreadcrumb() {
        this.breadcrumbEl.empty();

        const parts = this.currentPrefix.split('/').filter(p => p);
        let path = '';

        const rootBtn = this.breadcrumbEl.createEl('span', { cls: 'bitiful-breadcrumb-item', text: '🏠' });
        rootBtn.addEventListener('click', () => this.navigateTo(''));

        parts.forEach((part) => {
            this.breadcrumbEl.createEl('span', { text: ' / ' });
            path += part + '/';
            const btn = this.breadcrumbEl.createEl('span', { cls: 'bitiful-breadcrumb-item', text: part });
            const currentPath = path;
            btn.addEventListener('click', () => this.navigateTo(currentPath));
        });
    }

    // ===== 加载文件 + 统计 =====
    async loadFiles() {
        if (!this.treeContainer) return;

        this.treeContainer.empty();
        this.treeContainer.createEl('div', { cls: 'bitiful-loading', text: '⏳ 加载中...' });

        try {
            const s3 = new S3Client(this.plugin.settings);
            const { prefixes, contents } = await s3.listObjects(this.currentPrefix);
            this.apiCallCount++;

            this.fileTree = [];

            prefixes.forEach(prefix => {
                const name = prefix.replace(this.currentPrefix, '').replace(/\/$/, '');
                if (name) {
                    this.fileTree.push({
                        type: 'folder',
                        name: name,
                        path: prefix,
                        size: 0,
                        lastModified: ''
                    });
                }
            });

            contents.forEach(item => {
                const name = item.key.replace(this.currentPrefix, '');
                if (name && !name.endsWith('/')) {
                    this.fileTree.push({
                        type: 'file',
                        name: name,
                        path: item.key,
                        size: item.size,
                        lastModified: item.lastModified,
                        ext: name.split('.').pop().toLowerCase()
                    });
                }
            });

            this.renderFileTree();

            if (!this.isLoadingAll) {
                this.loadAllFilesAndStats();
            }
        } catch (e) {
            this.treeContainer.empty();
            const errDiv = this.treeContainer.createEl('div', { cls: 'bitiful-empty' });
            errDiv.innerHTML = `<div class="bitiful-empty-icon">❌</div><p>加载失败</p><p style="font-size:12px;color:var(--text-muted)">${e.message}</p>`;
        }
    }

    async loadAllFilesAndStats() {
        this.isLoadingAll = true;
        try {
            const s3 = new S3Client(this.plugin.settings);
            const allContents = await s3.listAllObjects();
            this.apiCallCount += Math.ceil(allContents.length / 1000);

            this.allFilesCache = allContents.map(item => ({
                type: 'file',
                name: item.key.split('/').pop(),
                path: item.key,
                size: item.size,
                lastModified: item.lastModified,
                ext: item.key.split('.').pop().toLowerCase(),
                fullPath: item.key
            }));

            let totalSize = 0;
            let imageCount = 0, imageSize = 0;
            let videoCount = 0, videoSize = 0;
            let audioCount = 0, audioSize = 0;
            let docCount = 0, docSize = 0;
            let otherCount = 0, otherSize = 0;
            const folderSet = new Set();
            const monthlyMap = new Map();

            allContents.forEach(item => {
                totalSize += item.size;
                const ext = item.key.split('.').pop().toLowerCase();

                if (IMAGE_EXTS.includes(ext)) {
                    imageCount++;
                    imageSize += item.size;
                } else if (VIDEO_EXTS.includes(ext)) {
                    videoCount++;
                    videoSize += item.size;
                } else if (AUDIO_EXTS.includes(ext)) {
                    audioCount++;
                    audioSize += item.size;
                } else if (DOC_EXTS.includes(ext)) {
                    docCount++;
                    docSize += item.size;
                } else {
                    otherCount++;
                    otherSize += item.size;
                }

                const dir = item.key.substring(0, item.key.lastIndexOf('/') + 1);
                if (dir) folderSet.add(dir);

                // 按月统计
                const date = item.lastModified ? new Date(item.lastModified) : new Date();
                const monthKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
                if (!monthlyMap.has(monthKey)) {
                    monthlyMap.set(monthKey, 0);
                }
                monthlyMap.set(monthKey, monthlyMap.get(monthKey) + item.size);
            });

            // 转换为数组并排序
            const monthlyData = Array.from(monthlyMap.entries())
                .sort((a, b) => a[0].localeCompare(b[0]))
                .slice(-7) // 最近7个月
                .map(([month, size]) => ({ month: month.split('-')[1] + '月', size }));

            const estimatedCost = this.estimateCost(totalSize, this.apiCallCount);

            this.usageStats = {
                totalSize,
                fileCount: allContents.length,
                folderCount: folderSet.size,
                imageCount, imageSize,
                videoCount, videoSize,
                audioCount, audioSize,
                docCount, docSize,
                otherCount, otherSize,
                monthlyData,
                estimatedCost
            };

            this.renderUsageOverview();
            this.renderDistribution();
            this.isLoadingAll = false;
        } catch (e) {
            this.isLoadingAll = false;
            console.error('统计加载失败:', e);
        }
    }

    renderFileTree() {
        this.treeContainer.empty();

        if (this.fileTree.length === 0) {
            const empty = this.treeContainer.createEl('div', { cls: 'bitiful-empty' });
            empty.innerHTML = '<div class="bitiful-empty-icon">📂</div><p>该目录为空</p>';
            return;
        }

        const sortBy = this.plugin.settings.sortBy;
        const sortOrder = this.plugin.settings.sortOrder;
        const multiplier = sortOrder === 'asc' ? 1 : -1;

        const sorted = [...this.fileTree].sort((a, b) => {
            if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;

            if (sortBy === 'name') {
                return a.name.localeCompare(b.name) * multiplier;
            } else if (sortBy === 'size') {
                return (a.size - b.size) * multiplier;
            } else if (sortBy === 'date') {
                const da = a.lastModified ? new Date(a.lastModified).getTime() : 0;
                const db = b.lastModified ? new Date(b.lastModified).getTime() : 0;
                return (da - db) * multiplier;
            }
            return 0;
        });

        sorted.forEach(item => {
            if (item.type === 'folder') {
                this.renderFolder(item);
            } else {
                this.renderFile(item);
            }
        });
    }

    getFileIcon(ext) {
        if (IMAGE_EXTS.includes(ext)) return '🖼️';
        if (VIDEO_EXTS.includes(ext)) return '🎬';
        if (AUDIO_EXTS.includes(ext)) return '🎵';
        if (DOC_EXTS.includes(ext)) return '📄';
        return '📎';
    }

    formatFileSize(bytes) {
        if (bytes === 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    }

    renderFolder(folder) {
        const folderEl = this.treeContainer.createDiv('bitiful-folder');
        const header = folderEl.createDiv('bitiful-folder-header');
        header.createEl('span', { cls: 'bitiful-folder-icon', text: '📁' });
        header.createEl('span', { cls: 'bitiful-folder-name', text: folder.name });
        header.addEventListener('click', () => this.navigateTo(folder.path));
    }

    renderFile(file) {
        const fileEl = this.treeContainer.createDiv('bitiful-file-item');
        fileEl.setAttribute('data-path', file.path);

        if (this.batchMode) {
            const checkbox = fileEl.createEl('input', {
                cls: 'bitiful-file-checkbox',
                attr: { type: 'checkbox' }
            });
            checkbox.checked = this.selectedFiles.has(file.path);
            checkbox.addEventListener('change', (e) => {
                if (e.target.checked) {
                    this.selectedFiles.add(file.path);
                } else {
                    this.selectedFiles.delete(file.path);
                }
                this.updateBatchCount();
            });
        }

        if (this.plugin.settings.enableImagePreview && IMAGE_EXTS.includes(file.ext)) {
            const s3 = new S3Client(this.plugin.settings);
            const thumbUrl = s3.getPublicUrl(file.path);
            const thumb = fileEl.createEl('img', {
                cls: 'bitiful-file-thumb',
                attr: { src: thumbUrl, loading: 'lazy' }
            });
            thumb.addEventListener('click', (e) => {
                e.stopPropagation();
                this.previewImage(file);
            });
        } else {
            const icon = this.getFileIcon(file.ext);
            fileEl.createEl('span', { cls: 'bitiful-file-icon', text: icon });
        }

        fileEl.createEl('span', { cls: 'bitiful-file-name', text: file.name, attr: { title: this.formatFileSize(file.size) } });

        const actions = fileEl.createDiv('bitiful-file-actions');

        const copyUrlBtn = actions.createEl('button', { cls: 'bitiful-action-btn', text: '🔗' });
        copyUrlBtn.title = '复制链接';
        copyUrlBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.copyFileLink(file, 'url');
        });

        const copyMdBtn = actions.createEl('button', { cls: 'bitiful-action-btn', text: '📝' });
        copyMdBtn.title = '复制 Markdown';
        copyMdBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.copyFileLink(file, 'markdown');
        });

        const insertBtn = actions.createEl('button', { cls: 'bitiful-action-btn', text: '⬇️' });
        insertBtn.title = '插入到当前笔记';
        insertBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.insertToEditor(file);
        });

        fileEl.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            this.showFileContextMenu(e, file);
        });

        if (IMAGE_EXTS.includes(file.ext)) {
            fileEl.addEventListener('dblclick', () => this.previewImage(file));
        }
    }

    navigateTo(prefix) {
        this.currentPrefix = prefix;
        this.renderBreadcrumb();
        this.loadFiles();
    }

    getActiveMarkdownView() {
        let view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (view) return view;

        const leaves = this.app.workspace.getLeavesOfType('markdown');
        for (const leaf of leaves) {
            if (leaf.view instanceof MarkdownView) {
                const state = leaf.getViewState();
                if (state && !state.pinned) {
                    return leaf.view;
                }
            }
        }

        const activeLeaf = this.app.workspace.activeLeaf;
        if (activeLeaf && activeLeaf.view instanceof MarkdownView) {
            return activeLeaf.view;
        }

        return null;
    }

    applyTemplate(file, url) {
        const ext = (file.ext || '').toLowerCase();

        // 根据文件类型使用不同的 Markdown 语法
        if (VIDEO_EXTS.includes(ext)) {
            // 视频使用 HTML5 video 标签
            return `<video controls src="${url}" style="width:100%;max-width:600px;"></video>`;
        } else if (AUDIO_EXTS.includes(ext)) {
            // 音频使用 HTML5 audio 标签
            return `<audio controls src="${url}" style="width:100%;"></audio>`;
        } else if (ext === 'pdf') {
            // PDF 使用链接形式（Obsidian 不支持远程 PDF 嵌入）
            return `[📄 ${file.name}](${url})`;
        } else {
            // 图片使用默认模板
            const template = this.plugin.settings.linkTemplate;
            const basename = file.name.split('.')[0];
            return template
                .replace(/\{\{filename\}\}/g, file.name)
                .replace(/\{\{url\}\}/g, url)
                .replace(/\{\{ext\}\}/g, ext)
                .replace(/\{\{basename\}\}/g, basename);
        }
    }

    async copyFileLink(file, format) {
        try {
            const s3 = new S3Client(this.plugin.settings);
            const url = s3.getPublicUrl(file.path);

            let text = url;
            if (format === 'markdown') {
                text = this.applyTemplate(file, url);
            } else if (format === 'html') {
                text = `<img src="${url}" alt="${file.name}" />`;
            }

            await navigator.clipboard.writeText(text);
            new Notice(`✅ 已复制: ${file.name}`);
            this.addToRecent(file);
        } catch (e) {
            new Notice(`❌ 复制失败: ${e.message}`);
        }
    }

    async insertToEditor(file) {
        const view = this.getActiveMarkdownView();
        if (!view) {
            new Notice('❌ 请先打开一个笔记（点击任意笔记使其获得焦点）');
            return;
        }

        const s3 = new S3Client(this.plugin.settings);
        const url = s3.getPublicUrl(file.path);

        const text = this.applyTemplate(file, url);

        view.editor.replaceSelection(text);
        new Notice(`✅ 已插入: ${file.name}`);
        this.addToRecent(file);
    }

    previewImage(file) {
        const s3 = new S3Client(this.plugin.settings);
        const url = s3.getPublicUrl(file.path);
        const modal = new ImagePreviewModal(this.app, url, file.name);
        modal.open();
    }

    async showExifInfo(file) {
        try {
            const s3 = new S3Client(this.plugin.settings);
            const url = s3.getPublicUrl(file.path);

            // 下载图片读取 EXIF
            const response = await fetch(url);
            const blob = await response.blob();
            const exifData = await ImageProcessor.readExif(blob);

            const modal = new ExifModal(this.app, exifData, file.name);
            modal.open();
        } catch (e) {
            new Notice(`❌ 读取 EXIF 失败: ${e.message}`);
        }
    }

    showFileContextMenu(event, file) {
        const menu = new Menu();

        menu.addItem((item) => {
            item.setTitle('🔗 复制链接');
            item.setIcon('link');
            item.onClick(() => this.copyFileLink(file, 'url'));
        });

        menu.addItem((item) => {
            item.setTitle('📝 复制 Markdown');
            item.setIcon('file-text');
            item.onClick(() => this.copyFileLink(file, 'markdown'));
        });

        menu.addItem((item) => {
            item.setTitle('⬇️ 插入到笔记');
            item.setIcon('download');
            item.onClick(() => this.insertToEditor(file));
        });

        if (IMAGE_EXTS.includes(file.ext)) {
            menu.addItem((item) => {
                item.setTitle('👁️ 预览图片');
                item.setIcon('image');
                item.onClick(() => this.previewImage(file));
            });

            menu.addItem((item) => {
                item.setTitle('📷 查看 EXIF');
                item.setIcon('camera');
                item.onClick(() => this.showExifInfo(file));
            });
        }

        menu.addSeparator();

        menu.addItem((item) => {
            item.setTitle('🗑️ 删除文件');
            item.setIcon('trash');
            item.onClick(() => this.deleteFile(file));
        });

        menu.showAtMouseEvent(event);
    }

    async deleteFile(file) {
        const modal = new Modal(this.app);
        modal.titleEl.setText('确认删除');
        modal.contentEl.setText(`确定要删除文件 "${file.name}" 吗？此操作不可恢复。`);

        const btnContainer = modal.contentEl.createDiv();
        btnContainer.style.cssText = 'display: flex; gap: 10px; margin-top: 20px;';

        const cancelBtn = btnContainer.createEl('button', { text: '取消' });
        cancelBtn.addEventListener('click', () => modal.close());

        const confirmBtn = btnContainer.createEl('button', { text: '删除', attr: { style: 'background: #ff5252; color: white;' } });
        confirmBtn.addEventListener('click', async () => {
            modal.close();
            try {
                const s3 = new S3Client(this.plugin.settings);
                await s3.deleteObject(file.path);
                new Notice(`✅ 已删除: ${file.name}`);
                await this.loadFiles();
            } catch (e) {
                new Notice(`❌ 删除失败: ${e.message}`);
            }
        });

        modal.open();
    }

    handleSearch(query) {
        if (!query) {
            this.renderFileTree();
            return;
        }

        const lowerQuery = query.toLowerCase();

        if (this.plugin.settings.searchAllFiles && this.allFilesCache.length > 0) {
            const filtered = this.allFilesCache.filter(item =>
                item.name.toLowerCase().includes(lowerQuery)
            );

            this.treeContainer.empty();

            if (filtered.length === 0) {
                this.treeContainer.createEl('div', { cls: 'bitiful-empty', text: '🔍 未找到匹配的文件' });
                return;
            }

            filtered.forEach(item => {
                this.renderSearchResult(item);
            });
        } else {
            const filtered = this.fileTree.filter(item =>
                item.name.toLowerCase().includes(lowerQuery)
            );

            this.treeContainer.empty();

            if (filtered.length === 0) {
                this.treeContainer.createEl('div', { cls: 'bitiful-empty', text: '🔍 未找到匹配的文件' });
                return;
            }

            filtered.forEach(item => {
                if (item.type === 'folder') {
                    this.renderFolder(item);
                } else {
                    this.renderFile(item);
                }
            });
        }
    }

    renderSearchResult(file) {
        const fileEl = this.treeContainer.createDiv('bitiful-file-item');
        fileEl.setAttribute('data-path', file.path);

        const icon = this.getFileIcon(file.ext);
        fileEl.createEl('span', { cls: 'bitiful-file-icon', text: icon });

        const nameEl = fileEl.createEl('span', { cls: 'bitiful-file-name' });
        nameEl.createEl('span', { text: file.name });
        const pathEl = nameEl.createEl('span', { cls: 'bitiful-file-path' });
        pathEl.setText(file.fullPath || file.path);
        nameEl.setAttribute('title', `${this.formatFileSize(file.size)}\n${file.fullPath || file.path}`);

        const actions = fileEl.createDiv('bitiful-file-actions');

        const copyUrlBtn = actions.createEl('button', { cls: 'bitiful-action-btn', text: '🔗' });
        copyUrlBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.copyFileLink(file, 'url');
        });

        const copyMdBtn = actions.createEl('button', { cls: 'bitiful-action-btn', text: '📝' });
        copyMdBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.copyFileLink(file, 'markdown');
        });

        const insertBtn = actions.createEl('button', { cls: 'bitiful-action-btn', text: '⬇️' });
        insertBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.insertToEditor(file);
        });

        fileEl.addEventListener('click', () => {
            const dir = file.path.substring(0, file.path.lastIndexOf('/') + 1);
            this.navigateTo(dir);
        });

        fileEl.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            this.showFileContextMenu(e, file);
        });
    }

    setupDragDrop() {
        this.dropZone.addEventListener('dragover', (e) => {
            e.preventDefault();
            this.dropZone.addClass('drag-over');
        });

        this.dropZone.addEventListener('dragleave', () => {
            this.dropZone.removeClass('drag-over');
        });

        this.dropZone.addEventListener('drop', async (e) => {
            e.preventDefault();
            this.dropZone.removeClass('drag-over');

            const files = Array.from(e.dataTransfer.files);
            if (files.length > 0) {
                await this.uploadFiles(files);
            }
        });
    }

    async handleUploadClick() {
        const input = document.createElement('input');
        input.type = 'file';
        input.multiple = true;
        input.addEventListener('change', async (e) => {
            const files = Array.from(e.target.files);
            if (files.length > 0) {
                await this.uploadFiles(files);
            }
        });
        input.click();
    }

    async uploadFiles(files) {
        const s3 = new S3Client(this.plugin.settings);
        const progressModal = new UploadProgressModal(this.app);
        progressModal.open();

        let successCount = 0;
        let failCount = 0;

        for (const file of files) {
            let key = this.currentPrefix + file.name;

            if (this.plugin.settings.autoRename) {
                const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
                key = this.currentPrefix + `${timestamp}_${file.name}`;
            }

            progressModal.addFile(file.name);

            try {
                let uploadFile = file;

                // 图片压缩
                if (this.plugin.settings.enableImageCompress && file.type.startsWith('image/')) {
                    try {
                        uploadFile = await ImageProcessor.compress(uploadFile, this.plugin.settings.compressQuality);
                        key = key.replace(/\.[^.]+$/, '.jpg');
                    } catch (e) {
                        console.log('压缩失败，使用原图:', e);
                    }
                }

                // 添加水印
                if (this.plugin.settings.enableWatermark && file.type.startsWith('image/')) {
                    try {
                        const watermarkText = this.plugin.settings.watermarkText || 'Obsidian';
                        uploadFile = await ImageProcessor.addWatermark(uploadFile, {
                            text: watermarkText,
                            position: this.plugin.settings.watermarkPosition,
                            opacity: this.plugin.settings.watermarkOpacity,
                            fontSize: this.plugin.settings.watermarkFontSize
                        });
                    } catch (e) {
                        console.log('水印添加失败:', e);
                    }
                }

                await s3.uploadFile(key, uploadFile, (percent) => {
                    progressModal.updateProgress(file.name, percent);
                });

                this.totalTraffic += uploadFile.size;
                progressModal.completeFile(file.name, true);
                successCount++;
                new Notice(`✅ 上传成功: ${file.name}`);
            } catch (e) {
                progressModal.completeFile(file.name, false);
                failCount++;
                new Notice(`❌ 上传失败: ${file.name} - ${e.message}`);
            }
        }

        setTimeout(() => progressModal.close(), 2000);

        if (successCount > 0) {
            new Notice(`🎉 上传完成: ${successCount} 成功, ${failCount} 失败`);
            await this.loadFiles();
        }
    }

    setupPasteHandler() {
        this.plugin.registerDomEvent(document, 'paste', async (e) => {
            const target = e.target;
            if (!target || !target.closest('.cm-editor')) return;

            const items = Array.from(e.clipboardData.items);
            const imageItems = items.filter(item => item.type.startsWith('image/'));

            if (imageItems.length === 0) return;

            e.preventDefault();

            for (const item of imageItems) {
                const file = item.getAsFile();
                if (!file) continue;

                const ext = file.type.split('/')[1] || 'png';
                const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
                let key = this.plugin.settings.uploadPathPrefix + `paste_${timestamp}.${ext}`;

                try {
                    new Notice(`⬆️ 正在上传剪贴板图片...`, 3000);

                    let uploadFile = file;

                    if (this.plugin.settings.enableImageCompress) {
                        try {
                            uploadFile = await ImageProcessor.compress(uploadFile, this.plugin.settings.compressQuality);
                            key = key.replace(/\.[^.]+$/, '.jpg');
                        } catch (e) {
                            console.log('压缩失败，使用原图');
                        }
                    }

                    if (this.plugin.settings.enableWatermark) {
                        try {
                            const watermarkText = this.plugin.settings.watermarkText || 'Obsidian';
                            uploadFile = await ImageProcessor.addWatermark(uploadFile, {
                                text: watermarkText,
                                position: this.plugin.settings.watermarkPosition,
                                opacity: this.plugin.settings.watermarkOpacity,
                                fontSize: this.plugin.settings.watermarkFontSize
                            });
                        } catch (e) {
                            console.log('水印添加失败:', e);
                        }
                    }

                    const s3 = new S3Client(this.plugin.settings);
                    const url = await s3.uploadFile(key, uploadFile);
                    this.totalTraffic += uploadFile.size;

                    const view = this.getActiveMarkdownView();
                    if (view) {
                        const text = this.applyTemplate({ name: `image_${timestamp}.jpg`, ext: 'jpg' }, url);
                        view.editor.replaceSelection(text);
                    }

                    new Notice(`✅ 图片已上传并插入`);
                    await this.loadFiles();
                } catch (err) {
                    new Notice(`❌ 上传失败: ${err.message}`);
                }
            }
        });
    }

    // ===== 自动同步本地文件夹 =====
    startAutoSync() {
        if (this.syncWatcher) {
            clearInterval(this.syncWatcher);
        }

        const syncFolder = this.plugin.settings.autoSyncFolder;
        if (!syncFolder) return;

        // 每 30 秒检查一次新文件
        this.syncWatcher = setInterval(async () => {
            await this.checkSyncFolder(syncFolder);
        }, 30000);

        new Notice(`🔄 自动同步已启动: ${syncFolder}`);
    }

    async checkSyncFolder(folderPath) {
        try {
            // 注意：Obsidian 插件无法直接访问文件系统
            // 这里使用 Obsidian 的 vault API 来访问 vault 内的文件夹
            const folder = this.app.vault.getAbstractFileByPath(folderPath);
            if (!folder || !(folder instanceof TFile)) {
                // 尝试作为绝对路径处理（桌面端）
                return;
            }
        } catch (e) {
            // 桌面端可以使用 Node.js fs 模块
            if (typeof require !== 'undefined') {
                try {
                    const fs = require('fs');
                    const path = require('path');

                    if (!fs.existsSync(folderPath)) return;

                    const files = fs.readdirSync(folderPath);
                    const s3 = new S3Client(this.plugin.settings);

                    for (const fileName of files) {
                        const filePath = path.join(folderPath, fileName);
                        const stat = fs.statSync(filePath);

                        if (stat.isFile()) {
                            const ext = fileName.split('.').pop().toLowerCase();
                            if (!IMAGE_EXTS.includes(ext) && !VIDEO_EXTS.includes(ext) && !AUDIO_EXTS.includes(ext) && !DOC_EXTS.includes(ext)) {
                                continue;
                            }

                            const key = this.plugin.settings.uploadPathPrefix + fileName;

                            // 检查是否已存在
                            try {
                                await s3.headObject(key);
                                continue; // 已存在，跳过
                            } catch {
                                // 不存在，上传
                            }

                            const fileData = fs.readFileSync(filePath);
                            const file = new File([fileData], fileName, { type: this.getMimeType(ext) });

                            await s3.uploadFile(key, file);
                            new Notice(`🔄 同步上传: ${fileName}`);
                        }
                    }
                } catch (err) {
                    console.error('同步失败:', err);
                }
            }
        }
    }

    getMimeType(ext) {
        const mimeTypes = {
            jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
            webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp',
            mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
            mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg',
            pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown',
        };
        return mimeTypes[ext] || 'application/octet-stream';
    }

    handleNewFolder() {
        const folderName = prompt('请输入文件夹名称:', 'new-folder');
        if (!folderName) return;
        new Notice(`📁 创建文件夹: ${folderName}（功能开发中）`);
    }
}

// ==================== 主插件类 ====================
module.exports = class BitifulPlugin extends Plugin {
    async onload() {
        await this.loadSettings();

        this.registerView(VIEW_TYPE_BITIFUL, (leaf) => new BitifulView(leaf, this));

        this.addRibbonIcon('image', '打开缤纷云助手', () => {
            this.activateView();
        });

        this.addCommand({
            id: 'open-sidebar',
            name: '打开缤纷云侧边栏',
            callback: () => this.activateView()
        });

        this.addCommand({
            id: 'upload-files',
            name: '上传文件到缤纷云',
            callback: () => this.uploadFileCommand()
        });

        this.addCommand({
            id: 'scan-note-images',
            name: '反查笔记中的缤纷云图片',
            callback: () => {
                const view = this.app.workspace.getLeavesOfType(VIEW_TYPE_BITIFUL)[0]?.view;
                if (view && view.scanNoteImages) {
                    view.scanNoteImages();
                }
            }
        });

        this.addSettingTab(new BitifulSettingTab(this.app, this));
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }

    async activateView() {
        const { workspace } = this.app;

        let leaf = workspace.getLeavesOfType(VIEW_TYPE_BITIFUL)[0];
        if (!leaf) {
            const rightLeaf = workspace.getRightLeaf(false);
            await rightLeaf.setViewState({ type: VIEW_TYPE_BITIFUL, active: true });
            leaf = workspace.getLeavesOfType(VIEW_TYPE_BITIFUL)[0];
        }

        workspace.revealLeaf(leaf);
    }

    async uploadFileCommand() {
        const input = document.createElement('input');
        input.type = 'file';
        input.multiple = true;
        input.addEventListener('change', async (e) => {
            const files = Array.from(e.target.files);
            if (files.length === 0) return;

            const view = this.app.workspace.getLeavesOfType(VIEW_TYPE_BITIFUL)[0]?.view;
            if (view && view.uploadFiles) {
                await view.uploadFiles(files);
            }
        });
        input.click();
    }

    onunload() {
        this.app.workspace.detachLeavesOfType(VIEW_TYPE_BITIFUL);
    }
};
