// @vitest-environment jsdom
/** Canvas page-image placeholder avoids a request before the PNG is uploaded. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { Canvas } from '../../src/client/components/Canvas'
import type { PageSize, Region } from '../../src/shared/types'

afterEach(cleanup)

const PAGE: PageSize = { widthPt: 1000, heightPt: 1000 }
const REGION: Region = {
  id: 'r1',
  page: 1,
  kind: 'article',
  bbox: { x: 50, y: 50, w: 300, h: 300 },
  lineIds: [],
  order: 0,
  confidence: 0.9,
  source: 'vision',
}

const props = {
  imageUrl: '/page.png',
  page: PAGE,
  regions: [REGION],
  selectedRegionId: null,
  onSelectRegion: vi.fn(),
  onMoveRegion: vi.fn(),
}

describe('Canvas page image readiness', () => {
  it('omits the img request until imageReady', () => {
    const { container, rerender } = render(<Canvas {...props} imageReady={false} />)
    expect(container.querySelector('img.lgp-canvas-image')).toBeNull()
    expect(container.querySelector('[data-lgp-image-placeholder="true"]')).not.toBeNull()
    rerender(<Canvas {...props} imageReady />)
    expect(container.querySelector('img.lgp-canvas-image')?.getAttribute('src')).toBe('/page.png')
    expect(container.querySelector('[data-lgp-image-placeholder="true"]')).toBeNull()
  })
})
