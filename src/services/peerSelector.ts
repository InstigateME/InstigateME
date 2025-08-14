/**
 * Re-exports real peerService.
 * Usage across app: import { peerService } from '@/services/peerSelector'
 */
import { peerService as realPeerService } from '@/services/peerService'

export const peerService = realPeerService
