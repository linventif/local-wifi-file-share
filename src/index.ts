import express from 'express';
import { readdir, stat, mkdir, watch } from 'fs/promises';
import { join, resolve, relative } from 'path';
import { existsSync, createReadStream } from 'fs';
import { networkInterfaces } from 'os';
import QRCode from 'qrcode';
import archiver from 'archiver';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'http';

const app = express();
const PORT = 3000;
const server = createServer(app);
const wss = new WebSocketServer({ server });

// Resolve directories
const IMPORTED_DIR = resolve('./data/imported');
const EXPORTABLE_DIR = resolve('./data/exportable');

// Ensure directories exist
if (!existsSync(IMPORTED_DIR)) await mkdir(IMPORTED_DIR, { recursive: true });
if (!existsSync(EXPORTABLE_DIR))
	await mkdir(EXPORTABLE_DIR, { recursive: true });

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// WebSocket connections
const clients = new Set<WebSocket>();

wss.on('connection', (ws) => {
	clients.add(ws);
	console.log('Client connected. Total clients:', clients.size);

	ws.on('close', () => {
		clients.delete(ws);
		console.log('Client disconnected. Total clients:', clients.size);
	});

	ws.on('error', (error) => {
		console.error('WebSocket error:', error);
		clients.delete(ws);
	});
});

// Broadcast to all connected clients
function broadcastUpdate(type: string, data?: any) {
	const message = JSON.stringify({ type, data, timestamp: Date.now() });
	clients.forEach((client) => {
		if (client.readyState === WebSocket.OPEN) {
			client.send(message);
		}
	});
}

// Watch for file system changes
async function watchDirectory(dir: string, name: string) {
	try {
		const watcher = watch(dir, { recursive: true });
		for await (const event of watcher) {
			console.log(`File system change in ${name}:`, event);
			broadcastUpdate('file-change', { directory: name, event });
		}
	} catch (error) {
		console.error(`Error watching ${name}:`, error);
	}
}

// Start watching directories
watchDirectory(IMPORTED_DIR, 'imported');
watchDirectory(EXPORTABLE_DIR, 'exportable');

// Get local IP addresses
function getLocalIPs(): string[] {
	const interfaces = networkInterfaces();
	const ips: string[] = [];

	for (const name of Object.keys(interfaces)) {
		const nets = interfaces[name];
		if (!nets) continue;

		for (const net of nets) {
			// Skip internal and non-IPv4 addresses
			if (net.family === 'IPv4' && !net.internal) {
				ips.push(net.address);
			}
		}
	}

	return ips;
}

// Recursively get all files in a directory
async function getAllFiles(
	dir: string,
	baseDir: string
): Promise<
	Array<{ path: string; name: string; size: number; modified: Date }>
> {
	const files: Array<{
		path: string;
		name: string;
		size: number;
		modified: Date;
	}> = [];

	try {
		const entries = await readdir(dir, { withFileTypes: true });

		for (const entry of entries) {
			const fullPath = join(dir, entry.name);

			if (entry.isDirectory()) {
				const subFiles = await getAllFiles(fullPath, baseDir);
				files.push(...subFiles);
			} else {
				const stats = await stat(fullPath);
				const relativePath = relative(baseDir, fullPath);

				files.push({
					path: relativePath,
					name: entry.name,
					size: stats.size,
					modified: stats.mtime,
				});
			}
		}
	} catch (error) {
		console.error(`Error reading directory ${dir}:`, error);
	}

	return files;
}

// Build recursive folder tree structure
interface FolderNode {
	name: string;
	path: string;
	files: Array<{ path: string; name: string; size: number; modified: Date }>;
	subfolders: Map<string, FolderNode>;
	totalSize: number;
}

function buildFolderTree(
	files: Array<{ path: string; name: string; size: number; modified: Date }>
): FolderNode {
	const root: FolderNode = {
		name: '',
		path: '',
		files: [],
		subfolders: new Map(),
		totalSize: 0,
	};

	for (const file of files) {
		const pathParts = file.path.split('/');
		let currentNode = root;

		// Navigate/create folder structure
		for (let i = 0; i < pathParts.length - 1; i++) {
			const folderName = pathParts[i];
			if (!folderName) continue; // Skip empty folder names
			const folderPath = pathParts.slice(0, i + 1).join('/');

			if (!currentNode.subfolders.has(folderName)) {
				currentNode.subfolders.set(folderName, {
					name: folderName,
					path: folderPath,
					files: [],
					subfolders: new Map(),
					totalSize: 0,
				});
			}
			currentNode = currentNode.subfolders.get(folderName)!;
		}

		// Add file to current folder
		currentNode.files.push(file);
	}

	// Calculate total sizes recursively
	function calculateSize(node: FolderNode): number {
		let size = node.files.reduce((sum, file) => sum + file.size, 0);
		for (const subfolder of node.subfolders.values()) {
			size += calculateSize(subfolder);
		}
		node.totalSize = size;
		return size;
	}
	calculateSize(root);

	return root;
}

// Format file size
function formatSize(bytes: number): string {
	if (bytes === 0) return '0 B';
	const k = 1024;
	const sizes = ['B', 'KB', 'MB', 'GB'];
	const i = Math.floor(Math.log(bytes) / Math.log(k));
	return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
}

// Render folder tree recursively
function renderFolderTree(node: FolderNode, level: number = 0): string {
	let html = '';
	const indent = level * 20;

	// Render subfolders first
	for (const [folderName, subfolder] of node.subfolders.entries()) {
		const folderId = subfolder.path.replace(/[^a-zA-Z0-9]/g, '_');
		html += `
        <div class="folder-group" style="margin-left: ${indent}px;">
          <div class="folder-header" onclick="toggleFolder('folder-${folderId}')">
            <div class="folder-title-section">
              <span class="folder-toggle" id="toggle-folder-${folderId}">▼</span>
              <span class="folder-title">📁 ${folderName}</span>
            </div>
            <div class="folder-actions">
              <button class="btn-download-all" onclick="event.stopPropagation(); downloadFolder('${
					subfolder.path
				}')">
                📦 Download All (${formatSize(subfolder.totalSize)})
              </button>
            </div>
          </div>
          <div class="folder-content" id="folder-${folderId}">
            ${
				subfolder.files.length > 0
					? `
            <ul class="file-list">
              ${subfolder.files
					.map(
						(file) => `
                <li class="file-item">
                  <div class="file-info">
                    <div class="file-name">📄 ${file.name}</div>
                    <div class="file-meta">${formatSize(
						file.size
					)} • ${new Date(file.modified).toLocaleString()}</div>
                  </div>
                  <div class="file-actions">
                    <button class="btn btn-primary btn-small" onclick="downloadFile('exportable', '${
						file.path
					}')">Download</button>
                  </div>
                </li>
              `
					)
					.join('')}
            </ul>
            `
					: ''
			}
            ${renderFolderTree(subfolder, level + 1)}
          </div>
        </div>
      `;
	}

	// Render root level files (files not in any subfolder)
	if (level === 0 && node.files.length > 0) {
		html += `
        <div class="folder-content">
          <ul class="file-list">
            ${node.files
				.map(
					(file) => `
              <li class="file-item">
                <div class="file-info">
                  <div class="file-name">📄 ${file.name}</div>
                  <div class="file-meta">${formatSize(file.size)} • ${new Date(
						file.modified
					).toLocaleString()}</div>
                </div>
                <div class="file-actions">
                  <button class="btn btn-primary btn-small" onclick="downloadFile('exportable', '${
						file.path
					}')">Download</button>
                </div>
              </li>
            `
				)
				.join('')}
          </ul>
        </div>
      `;
	}

	return html;
}

// Serve the main HTML page
app.get('/', async (req, res) => {
	const importedFiles = await getAllFiles(IMPORTED_DIR, IMPORTED_DIR);
	const exportableFiles = await getAllFiles(EXPORTABLE_DIR, EXPORTABLE_DIR);
	const exportableTree = buildFolderTree(exportableFiles);
	const localIPs = getLocalIPs();

	// Generate QR codes as data URLs
	const qrCodes = await Promise.all(
		localIPs.map((ip) =>
			QRCode.toDataURL(`http://${ip}:${PORT}`, {
				width: 128,
				margin: 1,
				color: {
					dark: '#000000',
					light: '#ffffff',
				},
			})
		)
	);

	const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Local WiFi File Share</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; padding: 20px; background: #f5f5f5; }
    .container { max-width: 1200px; margin: 0 auto; background: white; padding: 30px; border-radius: 12px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
    h1 { color: #333; margin-bottom: 10px; }
    .ip-info { background: #e3f2fd; padding: 20px; border-radius: 8px; margin-bottom: 20px; }
    .ip-info strong { color: #1976d2; display: block; margin-bottom: 15px; }
    .qr-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 20px; }
    .qr-item { background: white; padding: 15px; border-radius: 8px; text-align: center; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
    .qr-item img { display: block; margin: 0 auto 12px; border: 2px solid #ddd; border-radius: 8px; }
    .qr-url { font-family: monospace; font-size: 14px; color: #333; margin-bottom: 10px; word-break: break-all; }
    .copy-btn { background: #2196F3; color: white; border: none; padding: 8px 16px; border-radius: 4px; cursor: pointer; font-size: 14px; transition: all 0.2s; width: 100%; }
    .copy-btn:hover { background: #0b7dda; }
    .copy-btn:active { transform: scale(0.98); }
    .upload-section { background: #f9f9f9; padding: 20px; border-radius: 8px; margin-bottom: 30px; }
    .upload-area { border: 2px dashed #ccc; padding: 40px; text-align: center; border-radius: 8px; cursor: pointer; transition: all 0.3s; }
    .upload-area:hover { border-color: #4CAF50; background: #f1f8f4; }
    .upload-area.dragover { border-color: #4CAF50; background: #e8f5e9; }
    input[type="file"] { display: none; }
    .btn { padding: 12px 24px; border: none; border-radius: 6px; cursor: pointer; font-size: 16px; font-weight: 500; transition: all 0.3s; }
    .btn-primary { background: #4CAF50; color: white; }
    .btn-primary:hover { background: #45a049; }
    .btn-secondary { background: #2196F3; color: white; margin-left: 10px; }
    .btn-secondary:hover { background: #0b7dda; }
    .section { margin-bottom: 30px; }
    .section-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px; padding-bottom: 10px; border-bottom: 2px solid #eee; }
    .section h2 { color: #555; margin: 0; }
    .section-actions { display: flex; gap: 10px; }
    .btn-link-folder { background: #9C27B0; color: white; border: none; padding: 8px 16px; border-radius: 4px; cursor: pointer; font-size: 14px; transition: all 0.2s; }
    .btn-link-folder:hover { background: #7B1FA2; }
    .folder-group { margin-bottom: 25px; border: 1px solid #e0e0e0; border-radius: 8px; overflow: hidden; }
    .folder-header { background: #f5f5f5; padding: 12px 15px; display: flex; justify-content: space-between; align-items: center; cursor: pointer; user-select: none; }
    .folder-header:hover { background: #ebebeb; }
    .folder-title-section { display: flex; align-items: center; gap: 10px; flex: 1; }
    .folder-toggle { font-size: 14px; transition: transform 0.2s; }
    .folder-toggle.collapsed { transform: rotate(-90deg); }
    .folder-title { font-weight: 600; color: #333; font-size: 16px; }
    .folder-actions { display: flex; gap: 8px; align-items: center; }
    .btn-download-all { background: #FF9800; color: white; border: none; padding: 8px 16px; border-radius: 4px; cursor: pointer; font-size: 14px; transition: all 0.2s; }
    .btn-download-all:hover { background: #F57C00; }
    .folder-content { padding: 15px; background: white; }
    .folder-content.collapsed { display: none; }
    .file-list { list-style: none; }
    .file-item { padding: 12px; margin-bottom: 8px; background: #fafafa; border-radius: 6px; display: flex; justify-content: space-between; align-items: center; transition: all 0.2s; }
    .file-item:hover { background: #f0f0f0; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
    .file-info { flex: 1; }
    .file-name { font-weight: 500; color: #333; margin-bottom: 4px; }
    .file-meta { font-size: 12px; color: #888; }
    .file-actions { display: flex; gap: 8px; }
    .btn-small { padding: 6px 12px; font-size: 14px; }
    .progress-bar { width: 100%; height: 4px; background: #e0e0e0; border-radius: 2px; overflow: hidden; margin-top: 10px; display: none; }
    .progress-fill { height: 100%; background: #4CAF50; transition: width 0.3s; }
    .status-message { padding: 12px; border-radius: 6px; margin-top: 15px; display: none; }
    .status-success { background: #d4edda; color: #155724; border: 1px solid #c3e6cb; }
    .status-error { background: #f8d7da; color: #721c24; border: 1px solid #f5c6cb; }
    .empty-state { text-align: center; padding: 40px; color: #999; }

    /* Speedtest Styles */
    .speedtest-section { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 25px; border-radius: 12px; margin-bottom: 30px; color: white; }
    .speedtest-section h2 { color: white; margin-bottom: 15px; }
    .speedtest-controls { display: flex; gap: 10px; margin-bottom: 20px; flex-wrap: wrap; }
    .speedtest-results { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 15px; }
    .speedtest-card { background: rgba(255,255,255,0.15); backdrop-filter: blur(10px); padding: 20px; border-radius: 8px; text-align: center; }
    .speedtest-label { font-size: 14px; opacity: 0.9; margin-bottom: 8px; }
    .speedtest-value { font-size: 32px; font-weight: bold; margin-bottom: 5px; }
    .speedtest-unit { font-size: 16px; opacity: 0.8; }
    .btn-speedtest { background: rgba(255,255,255,0.2); color: white; border: 2px solid rgba(255,255,255,0.3); padding: 12px 24px; border-radius: 6px; cursor: pointer; font-size: 16px; font-weight: 500; transition: all 0.3s; }
    .btn-speedtest:hover { background: rgba(255,255,255,0.3); border-color: rgba(255,255,255,0.5); }
    .btn-speedtest:disabled { opacity: 0.5; cursor: not-allowed; }
    .speedtest-progress { height: 6px; background: rgba(255,255,255,0.2); border-radius: 3px; overflow: hidden; margin-top: 15px; }
    .speedtest-progress-bar { height: 100%; background: white; transition: width 0.3s; }

    /* Mobile Responsive Styles */
    @media (max-width: 768px) {
      body { padding: 10px; }
      .container { padding: 15px; }
      h1 { font-size: 24px; }
      h2 { font-size: 20px; }
      .qr-grid { grid-template-columns: 1fr; }
      .qr-item { padding: 12px; }
      .qr-item img { width: 100%; height: auto; max-width: 200px; }
      .upload-area { padding: 20px; }
      .btn { padding: 10px 18px; font-size: 14px; }
      .btn-secondary { margin-left: 0; margin-top: 10px; }
      .section-header { flex-direction: column; align-items: flex-start; gap: 10px; }
      .section-actions { width: 100%; flex-wrap: wrap; }
      .section-actions button { flex: 1; min-width: 140px; }
      .folder-header { flex-direction: column; align-items: flex-start; gap: 10px; }
      .folder-actions { width: 100%; justify-content: flex-start; }
      .file-item { flex-direction: column; align-items: flex-start; gap: 10px; }
      .file-actions { width: 100%; }
      .file-actions button { flex: 1; }
      .speedtest-controls { flex-direction: column; }
      .btn-speedtest { width: 100%; }
      .speedtest-results { grid-template-columns: 1fr; }
      .speedtest-value { font-size: 28px; }
    }

    @media (max-width: 480px) {
      .container { padding: 10px; border-radius: 8px; }
      h1 { font-size: 20px; }
      h2 { font-size: 18px; }
      .upload-area { padding: 15px; }
      .file-name { font-size: 14px; }
      .file-meta { font-size: 11px; }
      .btn-small { padding: 5px 10px; font-size: 13px; }
      .speedtest-section { padding: 15px; }
      .speedtest-card { padding: 15px; }
      .speedtest-value { font-size: 24px; }
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>📁 Local WiFi File Share</h1>

    <div class="speedtest-section">
      <h2>🚀 Network Speed Test</h2>
      <div class="speedtest-controls">
        <button class="btn-speedtest" onclick="runSpeedTest('download')">⬇️ Test Download</button>
        <button class="btn-speedtest" onclick="runSpeedTest('upload')">⬆️ Test Upload</button>
        <button class="btn-speedtest" onclick="runSpeedTest('both')">🔄 Test Both</button>
      </div>
      <div class="speedtest-results">
        <div class="speedtest-card">
          <div class="speedtest-label">Download Speed</div>
          <div class="speedtest-value" id="downloadSpeed">--</div>
          <div class="speedtest-unit">Mbps</div>
        </div>
        <div class="speedtest-card">
          <div class="speedtest-label">Upload Speed</div>
          <div class="speedtest-value" id="uploadSpeed">--</div>
          <div class="speedtest-unit">Mbps</div>
        </div>
        <div class="speedtest-card">
          <div class="speedtest-label">Latency</div>
          <div class="speedtest-value" id="latency">--</div>
          <div class="speedtest-unit">ms</div>
        </div>
      </div>
      <div class="speedtest-progress" id="speedtestProgress" style="display: none;">
        <div class="speedtest-progress-bar" id="speedtestProgressBar"></div>
      </div>
    </div>

    <div class="ip-info">
      <strong>📡 Connect from Your Phone - Scan QR Code or Copy URL</strong>
      <div class="qr-grid">
        ${localIPs
			.map(
				(ip, idx) => `
          <div class="qr-item">
            <img src="${qrCodes[idx]}" alt="QR Code for ${ip}" width="128" height="128" />
            <div class="qr-url">http://${ip}:${PORT}</div>
            <button class="copy-btn" onclick="copyToClipboard('http://${ip}:${PORT}')" title="Copy to clipboard">
              📋 Copy URL
            </button>
          </div>
        `
			)
			.join('')}
      </div>
    </div>

    <div class="upload-section">
      <h2>⬆️ Upload Files</h2>
      <div class="upload-area" id="uploadArea">
        <p style="font-size: 18px; color: #666; margin-bottom: 10px;">📤 Drag & drop files here</p>
        <p style="color: #999; margin-bottom: 15px;">or</p>
        <button class="btn btn-primary" onclick="document.getElementById('fileInput').click()">Choose Files</button>
        <button class="btn btn-secondary" onclick="document.getElementById('folderInput').click()">Choose Folder</button>
        <input type="file" id="fileInput" multiple>
        <input type="file" id="folderInput" webkitdirectory directory>
      </div>
      <div class="progress-bar" id="progressBar">
        <div class="progress-fill" id="progressFill"></div>
      </div>
      <div class="status-message" id="statusMessage"></div>
    </div>

    <div class="section">
      <div class="section-header">
        <h2>📤 Exportable Files (./data/exportable)</h2>
        <div class="section-actions">
          <button class="btn-link-folder" onclick="linkFolder()">
            🔗 Link Folder
          </button>
          ${
				exportableFiles.length > 0
					? `<button class="btn-download-all" onclick="downloadFolder('.')">
            📦 Download All (${formatSize(exportableTree.totalSize)})
          </button>`
					: ''
			}
        </div>
      </div>
      ${
			exportableFiles.length > 0
				? renderFolderTree(exportableTree)
				: '<div class="empty-state">No files in ./data/exportable directory</div>'
		}
    </div>

    <div class="section">
      <h2>📥 Imported Files (./data/imported)</h2>
      ${
			importedFiles.length > 0
				? `
        <ul class="file-list">
          ${importedFiles
				.map(
					(file) => `
            <li class="file-item">
              <div class="file-info">
                <div class="file-name">📄 ${file.path}</div>
                <div class="file-meta">${formatSize(file.size)} • ${new Date(
						file.modified
					).toLocaleString()}</div>
              </div>
              <div class="file-actions">
                <button class="btn btn-primary btn-small" onclick="downloadFile('imported', '${
					file.path
				}')">Download</button>
              </div>
            </li>
          `
				)
				.join('')}
        </ul>
      `
				: '<div class="empty-state">No files in ./data/imported directory</div>'
		}
    </div>
  </div>

  <script>
    const uploadArea = document.getElementById('uploadArea');
    const fileInput = document.getElementById('fileInput');
    const folderInput = document.getElementById('folderInput');
    const progressBar = document.getElementById('progressBar');
    const progressFill = document.getElementById('progressFill');
    const statusMessage = document.getElementById('statusMessage');

    // WebSocket connection for live updates
    let ws;
    let reconnectTimeout;

    function connectWebSocket() {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      ws = new WebSocket(protocol + '//' + window.location.host);

      ws.onopen = () => {
        console.log('✅ WebSocket connected - Live updates enabled');
        clearTimeout(reconnectTimeout);
      };

      ws.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data);
          console.log('📡 Update received:', message);

          if (message.type === 'file-change') {
            // Auto-refresh after a short delay to batch multiple changes
            clearTimeout(window.refreshTimer);
            window.refreshTimer = setTimeout(() => {
              console.log('🔄 Refreshing page due to file changes...');
              window.location.reload();
            }, 1000);
          }
        } catch (error) {
          console.error('WebSocket message error:', error);
        }
      };

      ws.onclose = () => {
        console.log('WebSocket disconnected. Reconnecting...');
        reconnectTimeout = setTimeout(connectWebSocket, 3000);
      };

      ws.onerror = (error) => {
        console.error('WebSocket error:', error);
      };
    }

    // Connect on page load
    connectWebSocket();

    // Speedtest functions
    async function measureLatency() {
      const start = performance.now();
      try {
        await fetch('/speedtest/ping');
        return Math.round(performance.now() - start);
      } catch (error) {
        console.error('Latency test failed:', error);
        return 0;
      }
    }

    async function testDownloadSpeed() {
      const sizes = [1, 5, 10]; // MB
      let totalSpeed = 0;
      let tests = 0;

      for (const size of sizes) {
        try {
          const start = performance.now();
          const response = await fetch('/speedtest/download?size=' + size);
          const blob = await response.blob();
          const duration = (performance.now() - start) / 1000; // seconds
          const speed = (blob.size * 8) / duration / 1000000; // Mbps
          totalSpeed += speed;
          tests++;
        } catch (error) {
          console.error('Download test ' + size + 'MB failed:', error);
        }
      }

      return tests > 0 ? totalSpeed / tests : 0;
    }

    async function testUploadSpeed() {
      const sizes = [1, 5, 10]; // MB
      let totalSpeed = 0;
      let tests = 0;

      for (const size of sizes) {
        try {
          const data = new Uint8Array(size * 1024 * 1024);
          const blob = new Blob([data]);
          const formData = new FormData();
          formData.append('file', blob, 'test.bin');

          const start = performance.now();
          await fetch('/speedtest/upload', {
            method: 'POST',
            body: formData
          });
          const duration = (performance.now() - start) / 1000; // seconds
          const speed = (size * 8) / duration; // Mbps
          totalSpeed += speed;
          tests++;
        } catch (error) {
          console.error('Upload test ' + size + 'MB failed:', error);
        }
      }

      return tests > 0 ? totalSpeed / tests : 0;
    }

    async function runSpeedTest(type) {
      const buttons = document.querySelectorAll('.btn-speedtest');
      buttons.forEach(btn => btn.disabled = true);

      const progress = document.getElementById('speedtestProgress');
      const progressBar = document.getElementById('speedtestProgressBar');
      progress.style.display = 'block';
      progressBar.style.width = '0%';

      try {
        // Measure latency
        document.getElementById('latency').textContent = '...';
        const latency = await measureLatency();
        document.getElementById('latency').textContent = latency;
        progressBar.style.width = '20%';

        if (type === 'download' || type === 'both') {
          document.getElementById('downloadSpeed').textContent = '...';
          progressBar.style.width = '40%';
          const downloadSpeed = await testDownloadSpeed();
          document.getElementById('downloadSpeed').textContent = downloadSpeed.toFixed(2);
          progressBar.style.width = '60%';
        }

        if (type === 'upload' || type === 'both') {
          document.getElementById('uploadSpeed').textContent = '...';
          progressBar.style.width = '70%';
          const uploadSpeed = await testUploadSpeed();
          document.getElementById('uploadSpeed').textContent = uploadSpeed.toFixed(2);
          progressBar.style.width = '100%';
        }

        setTimeout(() => {
          progress.style.display = 'none';
        }, 1000);
      } catch (error) {
        console.error('Speed test failed:', error);
        alert('Speed test failed: ' + error.message);
      } finally {
        buttons.forEach(btn => btn.disabled = false);
      }
    }

    // Copy to clipboard function
    function copyToClipboard(text) {
      navigator.clipboard.writeText(text).then(() => {
        // Visual feedback
        const btn = event.target;
        const originalText = btn.textContent;
        btn.textContent = '✓ Copied!';
        btn.style.background = '#4CAF50';
        setTimeout(() => {
          btn.textContent = originalText;
          btn.style.background = '#2196F3';
        }, 2000);
      }).catch(err => {
        alert('Failed to copy: ' + err);
      });
    }

    // Drag and drop handlers
    uploadArea.addEventListener('dragover', (e) => {
      e.preventDefault();
      uploadArea.classList.add('dragover');
    });

    uploadArea.addEventListener('dragleave', () => {
      uploadArea.classList.remove('dragover');
    });

    uploadArea.addEventListener('drop', (e) => {
      e.preventDefault();
      uploadArea.classList.remove('dragover');
      const files = Array.from(e.dataTransfer.files);
      uploadFiles(files);
    });

    fileInput.addEventListener('change', (e) => {
      const files = Array.from(e.target.files);
      uploadFiles(files);
      e.target.value = '';
    });

    folderInput.addEventListener('change', (e) => {
      const files = Array.from(e.target.files);
      uploadFiles(files);
      e.target.value = '';
    });

    async function uploadFiles(files) {
      if (files.length === 0) return;

      progressBar.style.display = 'block';
      statusMessage.style.display = 'none';

      const formData = new FormData();
      files.forEach(file => {
        formData.append('files', file, file.webkitRelativePath || file.name);
      });

      try {
        const response = await fetch('/upload', {
          method: 'POST',
          body: formData
        });

        progressFill.style.width = '100%';

        if (response.ok) {
          const result = await response.json();
          showStatus('✅ Successfully uploaded ' + result.count + ' file(s)!', 'success');
          setTimeout(() => window.location.reload(), 1500);
        } else {
          showStatus('❌ Upload failed: ' + await response.text(), 'error');
        }
      } catch (error) {
        showStatus('❌ Upload error: ' + error.message, 'error');
      } finally {
        setTimeout(() => {
          progressBar.style.display = 'none';
          progressFill.style.width = '0%';
        }, 2000);
      }
    }

    function showStatus(message, type) {
      statusMessage.textContent = message;
      statusMessage.className = 'status-message status-' + type;
      statusMessage.style.display = 'block';
    }

    function downloadFile(directory, filepath) {
      // Encode each path segment separately to preserve slashes
      const encodedPath = filepath.split('/').map(segment => encodeURIComponent(segment)).join('/');
      window.location.href = '/download/' + directory + '/' + encodedPath;
    }

    function downloadFolder(folderName) {
      window.location.href = '/download-folder/' + encodeURIComponent(folderName);
    }

    function toggleFolder(folderId) {
      const content = document.getElementById(folderId);
      const toggle = document.getElementById('toggle-' + folderId);

      if (content && toggle) {
        content.classList.toggle('collapsed');
        toggle.classList.toggle('collapsed');
      }
    }

    async function linkFolder() {
      const folderPath = prompt('Enter the absolute path to the folder you want to link:');
      if (!folderPath) return;

      try {
        const response = await fetch('/link-folder', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ folderPath })
        });

        if (response.ok) {
          const result = await response.json();
          alert('✅ ' + result.message);
          window.location.reload();
        } else {
          const error = await response.text();
          alert('❌ Failed to link folder: ' + error);
        }
      } catch (error) {
        alert('❌ Error: ' + error.message);
      }
    }
  </script>
</body>
</html>
  `;

	res.send(html);
});

// Link folder endpoint
app.post('/link-folder', express.json(), async (req, res) => {
	try {
		const { folderPath } = req.body;

		if (!folderPath) {
			return res.status(400).send('Folder path is required');
		}

		// Check if folder exists
		if (!existsSync(folderPath)) {
			return res.status(404).send('Folder does not exist');
		}

		const folderStat = await stat(folderPath);
		if (!folderStat.isDirectory()) {
			return res.status(400).send('Path is not a directory');
		}

		// Create symlink in exportable directory
		const folderName = folderPath.split('/').pop() || 'linked_folder';
		const linkPath = join(EXPORTABLE_DIR, folderName);

		// Check if link already exists
		if (existsSync(linkPath)) {
			return res
				.status(409)
				.send('A folder with this name already exists');
		}

		// Create symlink using Bun
		await Bun.spawn(['ln', '-s', folderPath, linkPath]).exited;

		// Notify clients of changes
		broadcastUpdate('folder-linked', { folderName });

		res.json({
			success: true,
			message: `Successfully linked folder: ${folderName}`,
		});
	} catch (error) {
		console.error('Link folder error:', error);
		res.status(500).send('Failed to link folder: ' + error);
	}
});

// Upload endpoint
app.post('/upload', async (req, res) => {
	try {
		const files = req.body?.files;

		if (!files || (Array.isArray(files) && files.length === 0)) {
			return res.status(400).send('No files uploaded');
		}

		let uploadCount = 0;
		const fileArray = Array.isArray(files) ? files : [files];

		for (const file of fileArray) {
			const buffer = await file.arrayBuffer();
			const fileName = file.name;
			const filePath = join(IMPORTED_DIR, fileName);

			// Create subdirectories if needed
			const dirPath = join(
				IMPORTED_DIR,
				fileName.split('/').slice(0, -1).join('/')
			);
			if (dirPath !== IMPORTED_DIR) {
				await mkdir(dirPath, { recursive: true });
			}

			await Bun.write(filePath, buffer);
			uploadCount++;
		}

		// Notify clients of new uploads
		broadcastUpdate('files-uploaded', { count: uploadCount });

		res.json({ success: true, count: uploadCount });
	} catch (error) {
		console.error('Upload error:', error);
		res.status(500).send('Upload failed: ' + error);
	}
});

// Speedtest endpoints
app.get('/speedtest/ping', (req, res) => {
	res.json({ status: 'ok' });
});

app.get('/speedtest/download', (req, res) => {
	const size = parseInt(req.query.size as string) || 1; // MB
	const buffer = Buffer.alloc(size * 1024 * 1024);
	res.setHeader('Content-Type', 'application/octet-stream');
	res.setHeader('Content-Length', buffer.length.toString());
	res.send(buffer);
});

app.post('/speedtest/upload', async (req, res) => {
	try {
		let receivedBytes = 0;
		req.on('data', (chunk) => {
			receivedBytes += chunk.length;
		});
		req.on('end', () => {
			res.json({ received: receivedBytes });
		});
	} catch (error) {
		res.status(500).json({ error: 'Upload test failed' });
	}
});

// Download folder as zip
app.get('/download-folder/:folderName', async (req, res) => {
	try {
		const folderName = decodeURIComponent(req.params.folderName);
		// Handle downloading entire exportable directory
		const folderPath =
			folderName === '.'
				? EXPORTABLE_DIR
				: join(EXPORTABLE_DIR, folderName);

		// Security check
		if (!folderPath.startsWith(EXPORTABLE_DIR)) {
			return res.status(403).send('Access denied');
		}

		if (!existsSync(folderPath)) {
			return res.status(404).send('Folder not found');
		}

		// Set headers for zip download
		const zipName = folderName === '.' ? 'exportable' : folderName;
		res.setHeader(
			'Content-Disposition',
			`attachment; filename="${zipName}.zip"`
		);
		res.setHeader('Content-Type', 'application/zip');

		// Create archive
		const archive = archiver('zip', { zlib: { level: 9 } });

		archive.on('error', (err) => {
			console.error('Archive error:', err);
			res.status(500).send('Archive creation failed');
		});

		// Pipe archive to response
		archive.pipe(res);

		// Add folder contents to archive
		archive.directory(folderPath, false);

		// Finalize archive
		await archive.finalize();
	} catch (error) {
		console.error('Folder download error:', error);
		res.status(500).send('Download failed');
	}
});

// Download endpoint - using app.use to handle wildcard paths
app.use('/download/:directory', async (req, res, next) => {
	// Only handle GET requests
	if (req.method !== 'GET') {
		return next();
	}

	try {
		const directory = req.params.directory as string;
		// Extract filepath from URL - req.originalUrl contains the full URL with encoded characters
		// Example: /download/exportable/folder/file.txt
		const urlPrefix = `/download/${directory}/`;
		let filepath = req.originalUrl;

		if (filepath.startsWith(urlPrefix)) {
			filepath = filepath.substring(urlPrefix.length);
		}

		// Decode the filepath
		filepath = decodeURIComponent(filepath);

		const baseDir =
			directory === 'imported' ? IMPORTED_DIR : EXPORTABLE_DIR;
		const fullPath = join(baseDir, filepath);

		console.log('Download request:', {
			directory,
			filepath,
			fullPath,
			exists: existsSync(fullPath),
		});

		// Security check: ensure path is within allowed directory
		if (!fullPath.startsWith(baseDir)) {
			return res.status(403).send('Access denied');
		}

		if (!existsSync(fullPath)) {
			return res.status(404).send(`File not found: ${filepath}`);
		}

		const file = Bun.file(fullPath);
		const buffer = Buffer.from(await file.arrayBuffer());

		res.setHeader(
			'Content-Disposition',
			`attachment; filename="${filepath.split('/').pop()}"`
		);
		res.setHeader('Content-Type', file.type || 'application/octet-stream');
		res.setHeader('Content-Length', buffer.length.toString());

		return res.send(buffer);
	} catch (error) {
		console.error('Download error:', error);
		res.status(500).send('Download failed');
	}
});

// Start server
server.listen(PORT, '0.0.0.0', () => {
	const ips = getLocalIPs();
	console.log('\n🚀 Local WiFi File Share Server Started!\n');
	console.log('📡 Access from your devices:');
	ips.forEach((ip) => {
		console.log(`   http://${ip}:${PORT}`);
	});
	console.log('\n📁 Sharing directories:');
	console.log(`   ./data/imported   -> ${IMPORTED_DIR} (uploads)`);
	console.log(`   ./data/exportable -> ${EXPORTABLE_DIR} (downloads)`);
	console.log('\n🔌 WebSocket server running for live updates');
	console.log('\n✨ Ready to share files!\n');
});
