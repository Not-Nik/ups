// ups (c) Nikolas Wipper 2026

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

#[derive(Debug)]
pub struct InternalError;
impl warp::reject::Reject for InternalError {}

#[derive(Debug)]
pub struct BadRequest;
impl warp::reject::Reject for BadRequest {}

#[derive(Debug)]
pub struct AccessDenied;
impl warp::reject::Reject for AccessDenied {}

#[derive(Debug)]
pub struct AccountExists;
impl warp::reject::Reject for AccountExists {}
