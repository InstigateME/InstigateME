/**
 * Selects real or mock peerService based on ?mockPeer=1 in URL.
 * Usage across app: import { peerService } from '@/services/peerSelector'
 */
import { peerService as realPeerService } from '@/services/peerService'
import { peerService as mockPeerService } from '@/services/peerService.mock'

function isMockEnabled(): boolean {
  try {
    const params = new URLSearchParams(window.location.search)
    const v = params.get('mockPeer')
    return v === '1' || v === 'true' || v === 'yes'
  } catch {
    return false
  }
}

export const peerService = isMockEnabled() ? mockPeerService : realPeerService
