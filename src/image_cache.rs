// ups (c) Nikolas Wipper 2026

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

//! The image proxy's in-memory cache: the most recently used images, by URL, so a
//! logo is fetched from toornament once rather than for every visitor. Lost on restart.

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};
use warp::hyper::body::Bytes;

/// How many images are kept; the least recently used one makes room for a new one.
pub const CAPACITY: usize = 256;
/// Bigger images are served but not kept, so the cache stays below
/// `CAPACITY * MAX_IMAGE_BYTES` (128 MB; team logos are a few kB each).
pub const MAX_IMAGE_BYTES: usize = 512 * 1024;

#[derive(Clone)]
pub struct Image {
    pub content_type: &'static str,
    pub body: Bytes,
}

pub struct ImageCache {
    capacity: usize,
    images: HashMap<String, Image>,
    // Keys from least to most recently used.
    order: VecDeque<String>,
}

pub type SharedImageCache = Arc<Mutex<ImageCache>>;

impl ImageCache {
    pub fn new(capacity: usize) -> Self {
        ImageCache {
            capacity,
            images: HashMap::new(),
            order: VecDeque::new(),
        }
    }

    pub fn shared() -> SharedImageCache {
        Arc::new(Mutex::new(ImageCache::new(CAPACITY)))
    }

    pub fn get(&mut self, url: &str) -> Option<Image> {
        let image = self.images.get(url)?.clone();
        self.touch(url);
        Some(image)
    }

    pub fn insert(&mut self, url: &str, image: Image) {
        if self.capacity == 0 || image.body.len() > MAX_IMAGE_BYTES {
            return;
        }
        if self.images.insert(url.to_string(), image).is_some() {
            self.touch(url);
            return;
        }
        self.order.push_back(url.to_string());
        if self.order.len() > self.capacity {
            if let Some(oldest) = self.order.pop_front() {
                self.images.remove(&oldest);
            }
        }
    }

    fn touch(&mut self, url: &str) {
        if let Some(at) = self.order.iter().position(|k| k == url) {
            if let Some(key) = self.order.remove(at) {
                self.order.push_back(key);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn image(bytes: usize) -> Image {
        Image {
            content_type: "image/png",
            body: Bytes::from(vec![0u8; bytes]),
        }
    }

    #[test]
    fn returns_what_was_inserted() {
        let mut cache = ImageCache::new(2);
        assert!(cache.get("a").is_none());
        cache.insert("a", image(3));
        let hit = cache.get("a").unwrap();
        assert_eq!(hit.body.len(), 3);
        assert_eq!(hit.content_type, "image/png");
    }

    #[test]
    fn evicts_the_least_recently_used() {
        let mut cache = ImageCache::new(2);
        cache.insert("a", image(1));
        cache.insert("b", image(1));
        // Reading `a` makes `b` the oldest.
        cache.get("a");
        cache.insert("c", image(1));
        assert!(cache.get("a").is_some());
        assert!(cache.get("b").is_none());
        assert!(cache.get("c").is_some());
    }

    #[test]
    fn reinserting_replaces_without_growing() {
        let mut cache = ImageCache::new(2);
        cache.insert("a", image(1));
        cache.insert("b", image(1));
        cache.insert("a", image(5));
        assert_eq!(cache.order.len(), 2);
        assert_eq!(cache.get("a").unwrap().body.len(), 5);
        // `a` was just used, so `b` goes first.
        cache.insert("c", image(1));
        assert!(cache.get("b").is_none());
    }

    #[test]
    fn skips_oversized_images() {
        let mut cache = ImageCache::new(2);
        cache.insert("big", image(MAX_IMAGE_BYTES + 1));
        assert!(cache.get("big").is_none());
        cache.insert("fits", image(MAX_IMAGE_BYTES));
        assert!(cache.get("fits").is_some());
    }
}
