// ups (c) Nikolas Wipper 2026

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

use serde_derive::{Deserialize, Serialize};

#[derive(Serialize)]
pub struct User {
    pub name: String,
}

#[derive(Deserialize, Serialize, Debug)]
pub struct Match {
    pub id: u64,
    pub team_a: String,
    pub team_b: String,
    pub logo_a: String,
    pub logo_b: String,
    pub section: String,
}

#[derive(Deserialize, Serialize, Debug)]
pub struct Prediction {
    pub name: String,
    pub id: u64,
    pub score_a: u64,
    pub score_b: u64,
}

#[derive(Deserialize, Serialize, Debug)]
pub struct PredictionSubmission {
    pub id: u64,
    pub score_a: u64,
    pub score_b: u64,
}

#[derive(Deserialize, Serialize, Debug)]
pub struct Submission {
    pub name: Option<String>,
    pub predictions: Vec<PredictionSubmission>,
}

#[derive(Serialize, Debug)]
pub struct Token {
    pub token: String,
}
