import express from 'express';
import { readdir, stat, mkdir } from 'fs/promises';
import { join, resolve, relative } from 'path';
import { existsSync } from 'fs';
import { networkInterfaces } from 'os';
import QRCode from 'qrcode';

const app = express();
const PORT = 3000;

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

// Format file size
function formatSize(bytes: number): string {
	if (bytes === 0) return '0 B';
	const k = 1024;
	const sizes = ['B', 'KB', 'MB', 'GB'];
	const i = Math.floor(Math.log(bytes) / Math.log(k));
	return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
}

// Serve the main HTML page
app.get('/', async (req, res) => {
	const importedFiles = await getAllFiles(IMPORTED_DIR, IMPORTED_DIR);
	const exportableFiles = await getAllFiles(EXPORTABLE_DIR, EXPORTABLE_DIR);
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
    .section h2 { color: #555; margin-bottom: 15px; padding-bottom: 10px; border-bottom: 2px solid #eee; }
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
  </style>
</head>
<body>
  <div class="container">
    <h1>📁 Local WiFi File Share</h1>

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
      <h2>📤 Exportable Files (./data/exportable)</h2>
      ${
			exportableFiles.length > 0
				? `
        <ul class="file-list">
          ${exportableFiles
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
      window.location.href = '/download/' + directory + '/' + encodeURIComponent(filepath);
    }
  </script>
</body>
</html>
  `;

	res.send(html);
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

		res.json({ success: true, count: uploadCount });
	} catch (error) {
		console.error('Upload error:', error);
		res.status(500).send('Upload failed: ' + error);
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
		// Extract filepath from URL path manually
		const filepath = req.path.replace('/', '');
		const baseDir =
			directory === 'imported' ? IMPORTED_DIR : EXPORTABLE_DIR;
		const fullPath = join(baseDir, decodeURIComponent(filepath));

		// Security check: ensure path is within allowed directory
		if (!fullPath.startsWith(baseDir)) {
			return res.status(403).send('Access denied');
		}

		if (!existsSync(fullPath)) {
			return res.status(404).send('File not found');
		}

		const file = Bun.file(fullPath);
		res.setHeader(
			'Content-Disposition',
			`attachment; filename="${filepath.split('/').pop()}"`
		);
		res.setHeader('Content-Type', file.type || 'application/octet-stream');

		return res.send(await file.arrayBuffer());
	} catch (error) {
		console.error('Download error:', error);
		res.status(500).send('Download failed');
	}
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
	const ips = getLocalIPs();
	console.log('\n🚀 Local WiFi File Share Server Started!\n');
	console.log('📡 Access from your devices:');
	ips.forEach((ip) => {
		console.log(`   http://${ip}:${PORT}`);
	});
	console.log('\n📁 Sharing directories:');
	console.log(`   ./data/imported   -> ${IMPORTED_DIR} (uploads)`);
	console.log(`   ./data/exportable -> ${EXPORTABLE_DIR} (downloads)`);
	console.log('\n✨ Ready to share files!\n');
});
