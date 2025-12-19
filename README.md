# local-wifi-file-share

A local WiFi file sharing system that works without internet connection. Share files bidirectionally between your phone and desktop.

## Features

-   📤 Upload files from phone to desktop
-   📥 Download files from desktop to phone
-   🔄 Bidirectional file transfer
-   📁 Automatic folder creation
-   🌐 Works on local network (no internet needed)
-   📱 Mobile-friendly interface
-   🎯 Drag & drop support
-   📊 File size and modification date display

## Installation

```bash
bun install
```

## Usage

```bash
bun run index.ts
```

The server will start and display local IP addresses. Connect from your phone using any of the displayed addresses (e.g., `http://192.168.1.100:3000`).

## Directories

-   `./src` - Source files directory (files you want to share)
-   `./data` - Upload destination directory (files uploaded from devices)

Both directories are automatically created if they don't exist.

## How It Works

1. Start the server on your desktop
2. Note the IP address(es) displayed
3. On your phone (connected to same WiFi), open the IP address in a browser
4. Upload files from phone or download files from desktop
5. All files are transferred directly over your local network

## Requirements

-   Bun runtime
-   Devices must be on the same WiFi network
-   No internet connection required

This project was created using `bun init` in bun v1.3.0. [Bun](https://bun.sh) is a fast all-in-one JavaScript runtime.
