package main

import (
	"bytes"
	"errors"
	"fmt"
	"image"
	"image/color"
	"image/jpeg"
	"io"
	"net/http"
	"strconv"
	"time"

	// Formats a photo may be uploaded in. Everything is stored as JPEG.
	_ "image/gif"
	_ "image/png"

	"github.com/gorilla/mux"
	"github.com/mattermost/mattermost/server/public/model"
	"golang.org/x/image/draw"
	_ "golang.org/x/image/webp"

	"github.com/BigForkLifter/matterlists/server/store"
)

const (
	// The webapp shrinks photos to this size before uploading; the server does the same
	// for clients that couldn't.
	photoMaxSide = 2048
	thumbMaxSide = 480

	photoQuality = 85
	thumbQuality = 80

	// maxPhotoPixels bounds the memory a decode takes (4 bytes per pixel), since the
	// server is small. Phone cameras are well under it.
	maxPhotoPixels = 50_000_000

	// maxPhotoUploadBytes caps an upload below the server's own maximum file size (100 MB
	// by default), since each upload is held in memory while it's processed. The webapp
	// sends a few hundred KB; this leaves room for a full-size photo it couldn't shrink.
	maxPhotoUploadBytes = 25 << 20

	// uploadWait is how long an upload waits for a free upload slot before giving up.
	uploadWait = 30 * time.Second
)

// photoError is a problem with an uploaded photo, worded to be shown to the user as is.
type photoError string

func (e photoError) Error() string { return string(e) }

const (
	errUnsupportedPhoto photoError = "This file type isn't supported. Use a JPEG, PNG, GIF or WebP photo."
	errTooManyPixels    photoError = "This photo has too many pixels. Try a smaller one."
	errUploadsBusy      photoError = "Too many photos are being uploaded right now. Try again in a moment."
)

// uploadSlots limits how many uploads are read into memory at once, each up to
// maxPhotoUploadBytes. Without it, many parallel uploads could run the server out of memory.
var uploadSlots = make(chan struct{}, 4)

// acquireUploadSlot waits for a free upload slot until wait passes or the request ends.
// It returns the function that frees the slot, or false if none came free.
func acquireUploadSlot(r *http.Request, wait time.Duration) (release func(), ok bool) {
	timer := time.NewTimer(wait)
	defer timer.Stop()
	select {
	case uploadSlots <- struct{}{}:
		return func() { <-uploadSlots }, true
	case <-timer.C:
		return nil, false
	case <-r.Context().Done():
		return nil, false
	}
}

// decodeSlots limits how many photos are decoded at once, each taking up to
// maxPhotoPixels*4 bytes of memory.
var decodeSlots = make(chan struct{}, 2)

// processPhoto decodes an uploaded image and re-encodes it as a JPEG no larger than
// photoMaxSide, plus a thumbnail. Re-encoding drops metadata such as GPS location.
func processPhoto(data []byte) (full, thumb []byte, width, height int, err error) {
	cfg, _, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil {
		return nil, nil, 0, 0, errUnsupportedPhoto
	}
	if cfg.Width <= 0 || cfg.Height <= 0 || cfg.Width*cfg.Height > maxPhotoPixels {
		return nil, nil, 0, 0, errTooManyPixels
	}

	decodeSlots <- struct{}{}
	defer func() { <-decodeSlots }()

	src, _, err := image.Decode(bytes.NewReader(data))
	if err != nil {
		return nil, nil, 0, 0, errUnsupportedPhoto
	}

	large := fitWithin(src, photoMaxSide)
	if full, err = encodeJPEG(large, photoQuality); err != nil {
		return nil, nil, 0, 0, err
	}
	if thumb, err = encodeJPEG(fitWithin(large, thumbMaxSide), thumbQuality); err != nil {
		return nil, nil, 0, 0, err
	}
	b := large.Bounds()
	return full, thumb, b.Dx(), b.Dy(), nil
}

// fitWithin scales src down so neither side exceeds maxSide, onto white so transparent
// areas don't turn black in the JPEG.
func fitWithin(src image.Image, maxSide int) image.Image {
	sb := src.Bounds()
	w, h := sb.Dx(), sb.Dy()
	if w > maxSide || h > maxSide {
		if w >= h {
			h = max(1, h*maxSide/w)
			w = maxSide
		} else {
			w = max(1, w*maxSide/h)
			h = maxSide
		}
	}
	dst := image.NewRGBA(image.Rect(0, 0, w, h))
	draw.Draw(dst, dst.Bounds(), image.NewUniform(color.White), image.Point{}, draw.Src)
	if w == sb.Dx() && h == sb.Dy() {
		draw.Draw(dst, dst.Bounds(), src, sb.Min, draw.Over)
	} else {
		draw.CatmullRom.Scale(dst, dst.Bounds(), src, sb, draw.Over, nil)
	}
	return dst
}

func encodeJPEG(img image.Image, quality int) ([]byte, error) {
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, img, &jpeg.Options{Quality: quality}); err != nil {
		return nil, fmt.Errorf("failed to encode photo: %w", err)
	}
	return buf.Bytes(), nil
}

// maxPhotoBytes is the largest upload accepted: the server's own maximum file size, but
// no more than maxPhotoUploadBytes.
func (p *Plugin) maxPhotoBytes() int64 {
	if cfg := p.API.GetConfig(); cfg != nil && cfg.FileSettings.MaxFileSize != nil && *cfg.FileSettings.MaxFileSize > 0 {
		return min(*cfg.FileSettings.MaxFileSize, maxPhotoUploadBytes)
	}
	return maxPhotoUploadBytes
}

// isPhotoUpload tells the body-size middleware which requests may be larger.
func isPhotoUpload(r *http.Request) bool {
	return r.Method == http.MethodPost && photoUploadPath.MatchString(r.URL.Path)
}

// handleUploadPhoto takes the image as the raw request body and adds it to the end of
// the item's photos cell, returning the updated item.
func (p *Plugin) handleUploadPhoto(w http.ResponseWriter, r *http.Request) {
	item, list, ok := p.itemForRequest(w, r)
	if !ok {
		return
	}
	column, err := p.store.GetColumn(mux.Vars(r)["column_id"])
	if errors.Is(err, store.ErrNotFound) || (err == nil && column.ListID != list.ID) {
		writeError(w, r, http.StatusNotFound, "Column not found.")
		return
	}
	if err != nil {
		p.internalError(w, r, err)
		return
	}
	if column.Type != store.ColumnPhotos {
		writeError(w, r, http.StatusBadRequest, "Photos can only be added to a Photos column.")
		return
	}

	release, ok := acquireUploadSlot(r, uploadWait)
	if !ok {
		writeError(w, r, http.StatusServiceUnavailable, errUploadsBusy.Error())
		return
	}
	defer release()

	data, err := io.ReadAll(r.Body)
	var tooLarge *http.MaxBytesError
	if errors.As(err, &tooLarge) {
		writeError(w, r, http.StatusRequestEntityTooLarge, fmt.Sprintf("Photos can be at most %d MB.", tooLarge.Limit>>20))
		return
	}
	if err != nil {
		writeError(w, r, http.StatusBadRequest, "The upload didn't finish. Please try again.")
		return
	}

	full, thumb, width, height, err := processPhoto(data)
	var userErr photoError
	if errors.As(err, &userErr) {
		writeError(w, r, http.StatusBadRequest, userErr.Error())
		return
	}
	if err != nil {
		p.internalError(w, r, err)
		return
	}

	photo := &store.Photo{
		ID: model.NewId(), ListID: list.ID, ItemID: item.ID, ColumnID: column.ID, CreatorID: userID(r),
		CreateAt: model.GetMillis(), Width: width, Height: height, Size: len(full),
	}
	updated, err := p.store.AddPhoto(photo, full, thumb)
	if errors.Is(err, store.ErrTooManyPhotos) {
		writeError(w, r, http.StatusBadRequest, fmt.Sprintf("%s can have at most %d photos.", column.Name, store.MaxPhotosPerCell))
		return
	}
	if err != nil {
		p.storeError(w, r, err)
		return
	}
	p.notifyListChanged(list.ChannelID, list.ID, userID(r))
	writeJSON(w, r, http.StatusCreated, updated)
}

// handleGetPhoto serves a photo to anyone who can read its list. ?size=thumb serves the
// thumbnail. A photo's bytes never change, so browsers may cache it for good.
func (p *Plugin) handleGetPhoto(w http.ResponseWriter, r *http.Request) {
	listID, data, err := p.store.GetPhotoImage(mux.Vars(r)["photo_id"], r.URL.Query().Get("size") == "thumb")
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, r, http.StatusNotFound, "Photo not found.")
		return
	}
	if err != nil {
		p.internalError(w, r, err)
		return
	}
	if _, ok := p.listForRequest(w, r, listID, false); !ok {
		return
	}
	w.Header().Set("Content-Type", "image/jpeg")
	w.Header().Set("Content-Length", strconv.Itoa(len(data)))
	w.Header().Set("Cache-Control", "private, max-age=31536000, immutable")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(data)
}
