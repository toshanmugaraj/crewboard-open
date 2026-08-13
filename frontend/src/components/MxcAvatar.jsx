import { useEffect, useState } from 'react'
import { Avatar } from '@mui/material'

// ── MXC-backed avatar ────────────────────────────────────────────────────
// Thin wrapper around MUI's Avatar for anywhere in the app that just needs
// "show this mxc:// as an avatar, fall back to children if there isn't one/
// it fails to load". Media requires an authenticated download now (see
// matrixStore.js's fetchMediaBlob(), which goes through the Widget API's
// downloadFile() / MSC4039), so this can't be a synchronous
// `<Avatar src={someUrl}>` — it has to resolve the mxc:// via `fetchFn`
// (api.media.url, api.persons.imageUrl, api.vehicles.imageUrl, or
// api.matrix.userAvatarUrl, depending on caller) in a useEffect and hand
// MUI's Avatar the resulting blob: URL once ready. Avatar's own
// image-load-error handling already falls back to children when `src` is
// null/undefined or fails, so this doesn't need to track failure itself.
//
// Originally lived only in Database.jsx (persons/vehicles lists,
// directory-search results); extracted (2026-08-13) so MapBoard.jsx can
// reuse it for the map pins, the right panel's Persons list, and the "Live
// now" list without duplicating the fetch-on-mount logic.
export default function MxcAvatar({ mxc, fetchFn, children, ...avatarProps }) {
  const [url, setUrl] = useState(null)
  useEffect(() => {
    let cancelled = false
    setUrl(null)
    if (!mxc) return
    fetchFn(mxc).then(u => { if (!cancelled) setUrl(u) }).catch(() => {})
    return () => { cancelled = true }
  }, [mxc, fetchFn])
  return <Avatar src={url || undefined} {...avatarProps}>{children}</Avatar>
}
