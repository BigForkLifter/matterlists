package main

import (
	"bytes"
	"context"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/mattermost/mattermost/server/public/model"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func encodePNG(t *testing.T, w, h int, c color.Color) []byte {
	img := image.NewNRGBA(image.Rect(0, 0, w, h))
	for y := range h {
		for x := range w {
			img.Set(x, y, c)
		}
	}
	var buf bytes.Buffer
	require.NoError(t, png.Encode(&buf, img))
	return buf.Bytes()
}

func TestProcessPhoto(t *testing.T) {
	t.Run("large photo is shrunk to JPEG with a thumbnail", func(t *testing.T) {
		full, thumb, w, h, err := processPhoto(encodePNG(t, 3000, 1500, color.NRGBA{R: 200, A: 255}))
		require.NoError(t, err)
		assert.Equal(t, photoMaxSide, w)
		assert.Equal(t, photoMaxSide/2, h)

		cfg, format, err := image.DecodeConfig(bytes.NewReader(full))
		require.NoError(t, err)
		assert.Equal(t, "jpeg", format)
		assert.Equal(t, photoMaxSide, cfg.Width)

		tcfg, err := jpeg.DecodeConfig(bytes.NewReader(thumb))
		require.NoError(t, err)
		assert.Equal(t, thumbMaxSide, tcfg.Width)
		assert.Equal(t, thumbMaxSide/2, tcfg.Height)
	})

	t.Run("small photo keeps its size", func(t *testing.T) {
		_, _, w, h, err := processPhoto(encodePNG(t, 300, 400, color.NRGBA{B: 200, A: 255}))
		require.NoError(t, err)
		assert.Equal(t, 300, w)
		assert.Equal(t, 400, h)
	})

	t.Run("transparency becomes white", func(t *testing.T) {
		full, _, _, _, err := processPhoto(encodePNG(t, 10, 10, color.NRGBA{}))
		require.NoError(t, err)
		img, err := jpeg.Decode(bytes.NewReader(full))
		require.NoError(t, err)
		r, g, b, _ := img.At(5, 5).RGBA()
		assert.Greater(t, r>>8, uint32(240))
		assert.Greater(t, g>>8, uint32(240))
		assert.Greater(t, b>>8, uint32(240))
	})

	t.Run("not an image", func(t *testing.T) {
		_, _, _, _, err := processPhoto([]byte("%PDF-1.7 hello"))
		assert.ErrorIs(t, err, errUnsupportedPhoto)
	})
}

func TestMaxPhotoBytes(t *testing.T) {
	for name, tc := range map[string]struct {
		serverMax *int64
		want      int64
	}{
		"server default of 100 MB is capped": {model.NewPointer(int64(100 << 20)), maxPhotoUploadBytes},
		"a smaller server limit wins":        {model.NewPointer(int64(5 << 20)), 5 << 20},
		"no server limit":                    {nil, maxPhotoUploadBytes},
	} {
		t.Run(name, func(t *testing.T) {
			plugin, api := newTestPlugin()
			cfg := &model.Config{}
			cfg.FileSettings.MaxFileSize = tc.serverMax
			api.On("GetConfig").Return(cfg)
			assert.Equal(t, tc.want, plugin.maxPhotoBytes())
		})
	}
}

func TestAcquireUploadSlot(t *testing.T) {
	r := httptest.NewRequest(http.MethodPost, "/", nil)
	var releases []func()
	for range cap(uploadSlots) {
		release, ok := acquireUploadSlot(r, time.Second)
		require.True(t, ok)
		releases = append(releases, release)
	}

	_, ok := acquireUploadSlot(r, 10*time.Millisecond)
	assert.False(t, ok, "no slot is free while all are taken")

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, ok = acquireUploadSlot(r.WithContext(ctx), time.Minute)
	assert.False(t, ok, "a request that has ended stops waiting")

	releases[0]()
	release, ok := acquireUploadSlot(r, time.Second)
	assert.True(t, ok, "a released slot can be taken again")
	release()
	for _, release := range releases[1:] {
		release()
	}
	assert.Empty(t, uploadSlots)
}
