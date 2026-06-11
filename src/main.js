const { app, BrowserWindow, ipcMain, shell, Menu, net, Tray, nativeImage } = require('electron')
const path = require('path')

let mainWindow
let tray = null
let isQuitting = false

function createTray() {
  const iconPath = path.join(__dirname, '../assets/icon.png')
  const icon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 })
  tray = new Tray(icon)
  const contextMenu = Menu.buildFromTemplate([
    { label: 'Ogg Desktop', enabled: false },
    { type: 'separator' },
    { label: 'Show wallet', click: () => { mainWindow.show(); mainWindow.focus(); } },
    { type: 'separator' },
    { label: 'Exit', click: () => { isQuitting = true; app.quit(); } }
  ])
  tray.setToolTip('Ogg Desktop')
  tray.setContextMenu(contextMenu)
  tray.on('click', () => { mainWindow.show(); mainWindow.focus(); })
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 760,
    minWidth: 800,
    minHeight: 560,
    frame: false,
    backgroundColor: '#f0f0f8',
    icon: path.join(__dirname, '../assets/icon.png'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: false,
      webSecurity: false,
      preload: path.join(__dirname, 'preload.js'),
    }
  })
  mainWindow.loadFile(path.join(__dirname, 'index.html'))
  Menu.setApplicationMenu(null)

  // Minimize to taskbar (not tray)
  mainWindow.on('minimize', (e) => {
    // Just minimize normally to taskbar - default behaviour
  })

  // Close to tray
  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault()
      mainWindow.hide()
      if (tray) tray.displayBalloon && tray.displayBalloon({
        title: 'Ogg Desktop',
        content: 'Running in background. Right-click tray icon to exit.'
      })
    }
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.key === 'F12') mainWindow.webContents.openDevTools({ mode: 'detach' })
  })
}

app.whenReady().then(() => {
  createWindow()
  createTray()
})

app.on('window-all-closed', () => {
  // Don't quit - stay in tray
})

app.on('before-quit', () => {
  isQuitting = true
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
  else mainWindow.show()
})

ipcMain.on('window-minimize', () => mainWindow && mainWindow.minimize())
ipcMain.on('window-maximize', () => {
  if (!mainWindow) return
  if (mainWindow.isMaximized()) mainWindow.unmaximize()
  else mainWindow.maximize()
})
ipcMain.on('window-close', () => {
  // Hide to tray instead of closing
  mainWindow && mainWindow.hide()
})
ipcMain.handle('get-user-data-path', () => app.getPath('userData'))

ipcMain.handle('rpc-call', async (event, url, body) => {
  console.log('[RPC]', body.method)
  return new Promise((resolve, reject) => {
    const request = net.request({ method: 'POST', url })
    request.setHeader('Content-Type', 'application/json')
    request.setHeader('Accept', 'application/json')
    let data = ''
    request.on('response', (response) => {
      response.on('data', (chunk) => { data += chunk.toString() })
      response.on('end', () => {
        try { resolve(JSON.parse(data)) }
        catch(e) { reject(new Error('Bad JSON: ' + data.slice(0,100))) }
      })
    })
    request.on('error', (err) => { console.error('[RPC ERROR]', err.message); reject(err) })
    request.write(JSON.stringify(body))
    request.end()
  })
})
