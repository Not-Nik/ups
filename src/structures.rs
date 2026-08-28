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
pub struct Tournament {
    pub tournament_id: u64,
    pub name: String,
    pub toornament_id: Option<String>,
}

#[derive(Deserialize, Serialize, Debug)]
pub struct Match {
    pub id: u64,
    pub tournament_id: u64,
    pub team_a: String,
    pub team_b: String,
    pub logo_a: String,
    pub logo_b: String,
    pub score_a: Option<u64>,
    pub score_b: Option<u64>,
    pub toornament_id: Option<String>,
    pub stage_type: Option<String>,
    pub stage_number: Option<u64>,
    pub stage_name: String,
    pub group_name: String,
    pub round_name: String,
}

#[derive(Deserialize, Serialize, Debug)]
pub struct BracketNode {
    pub node_id: String,
    pub tournament_id: u32,
    pub stage_id: String,
    pub stage_name: String,
    pub stage_number: u64,
    pub stage_type: String,
    pub group_name: String,
    pub branch: Option<String>,
    pub round_number: u64,
    pub position: u64,
    pub depth: u64,
    pub team_a: Option<String>,
    pub team_b: Option<String>,
    pub logo_a: Option<String>,
    pub logo_b: Option<String>,
    pub score_a: Option<u64>,
    pub score_b: Option<u64>,
    pub source_type_a: Option<String>,
    pub source_a: Option<String>,
    pub source_type_b: Option<String>,
    pub source_b: Option<String>,
    pub match_id: Option<u64>,
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

#[derive(Deserialize, Debug)]
pub struct Login {
    pub name: String,
    pub password: String,
}

#[derive(Deserialize, Debug)]
pub struct Password {
    pub password: String,
}

#[derive(Serialize, Deserialize)]
pub struct ProxyQuery {
    pub url: String,
}

#[derive(Serialize, Deserialize)]
pub struct Bracket {
    pub tournament_id: u64,
    pub stage: String,
    pub group: String,
}
