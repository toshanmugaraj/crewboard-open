import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@matrix-widget-toolkit/api', async () => {
  const actual = await vi.importActual('@matrix-widget-toolkit/api')
  const { mockWidgetApi } = await vi.importActual('@matrix-widget-toolkit/testing')
  
  const mockApi = mockWidgetApi({
    roomId: '!my-room:example.com',
    widgetId: 'my-widget-id',
  })
  
  mockApi.matrixWidgetApi = {
    on: vi.fn(),
    off: vi.fn(),
    setAlwaysOnScreen: vi.fn().mockResolvedValue(undefined),
  }
  
  globalThis.__mockApiInstance = mockApi
  
  return {
    ...actual,
    WidgetApiImpl: {
      create: vi.fn(() => Promise.resolve(globalThis.__mockApiInstance))
    }
  }
})

describe('widget.js', () => {
  const originalLocation = window.location
  let mockApiInstance

  beforeEach(() => {
    mockApiInstance = globalThis.__mockApiInstance
    // Default location to have a widgetId to avoid initial load errors
    delete window.location
    window.location = new URL('http://localhost/?widgetId=my-widget-id')
  })

  afterEach(() => {
    window.location = originalLocation
    vi.clearAllMocks()
    vi.resetModules()
  })

  describe('initWidget', () => {
    it('should reject if widgetId is missing in URL parameters', async () => {
      // Re-import with a search that has no widgetId
      vi.resetModules()
      window.location = new URL('http://localhost/')
      const { initWidget } = await import('./widget.js')
      
      await expect(initWidget()).rejects.toThrow(/No widgetId in the URL/)
    })

    it('should resolve with the widgetApi when widgetId is present', async () => {
      vi.resetModules()
      window.location = new URL('http://localhost/?widgetId=my-widget-id')
      const { initWidget } = await import('./widget.js')

      const api = await initWidget()
      expect(api).toBe(mockApiInstance)
      expect(api.widgetId).toBe('my-widget-id')
    })
  })

  describe('getRoomId', () => {
    it('should return roomId from widget parameters when available', async () => {
      vi.resetModules()
      window.location = new URL('http://localhost/?widgetId=my-widget-id')
      const { initWidget, getRoomId } = await import('./widget.js')
      
      const api = await initWidget()
      api.widgetParameters = { roomId: '!test-room:example.com' }
      expect(getRoomId()).toBe('!test-room:example.com')
    })

    it('should fall back to roomId query parameter when widgetApi is not ready or has no parameters', async () => {
      vi.resetModules()
      window.location = new URL('http://localhost/?roomId=!fallback-room:example.com')
      const { getRoomId } = await import('./widget.js')
      
      expect(getRoomId()).toBe('!fallback-room:example.com')
    })
  })

  describe('navigateTo', () => {
    it('should throw error if widgetApi is not ready yet', async () => {
      vi.resetModules()
      window.location = new URL('http://localhost/?widgetId=my-widget-id')
      const { navigateTo } = await import('./widget.js')
      
      await expect(navigateTo('https://matrix.to/#/!another-room:example.com')).rejects.toThrow(
        "Can't open Element from here — the CrewBoard widget connection isn't ready yet."
      )
    })

    it('should call widgetApi.navigateTo when widgetApi is ready', async () => {
      vi.resetModules()
      window.location = new URL('http://localhost/?widgetId=my-widget-id')
      const { initWidget, navigateTo } = await import('./widget.js')
      
      const api = await initWidget()
      const navigateSpy = vi.spyOn(api, 'navigateTo').mockResolvedValue(undefined)
      
      await navigateTo('https://matrix.to/#/!another-room:example.com')
      expect(navigateSpy).toHaveBeenCalledWith('https://matrix.to/#/!another-room:example.com')
    })
  })

  describe('fixWidgetName', () => {
    it('should request capabilities and repair widget registration if current name is Custom Widget', async () => {
      vi.resetModules()
      window.location = new URL('http://localhost/?widgetId=my-widget-id')
      const { initWidget, fixWidgetName } = await import('./widget.js')
      
      const api = await initWidget()

      vi.spyOn(api, 'requestCapabilities').mockResolvedValue(undefined)
      vi.spyOn(api, 'receiveSingleStateEvent').mockResolvedValue({
        content: { name: 'Custom Widget' }
      })

      await fixWidgetName('My Crewboard')

      expect(api.requestCapabilities).toHaveBeenCalled()
      expect(api.receiveSingleStateEvent).toHaveBeenCalledWith('im.vector.modular.widgets', 'my-widget-id')
    })
  })
})
