# On-demand tables. PITR off in the sandbox (say "on" as the prod default).
# List-by-owner is a Query on gsi-owner — never a Scan.

resource "aws_dynamodb_table" "assets" {
  name         = "${local.name_prefix}-assets"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "assetId"

  attribute {
    name = "assetId"
    type = "S"
  }

  attribute {
    name = "ownerId"
    type = "S"
  }

  global_secondary_index {
    name            = "gsi-owner"
    hash_key        = "ownerId"
    range_key       = "assetId"
    projection_type = "ALL"
  }

  point_in_time_recovery {
    enabled = false
  }
}

resource "aws_dynamodb_table" "harvests" {
  name         = "${local.name_prefix}-harvests"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "assetId"
  range_key    = "harvestId"

  attribute {
    name = "assetId"
    type = "S"
  }

  attribute {
    name = "harvestId"
    type = "S"
  }

  point_in_time_recovery {
    enabled = false
  }
}

resource "aws_dynamodb_table" "jobs" {
  name         = "${local.name_prefix}-jobs"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "jobId"

  attribute {
    name = "jobId"
    type = "S"
  }

  point_in_time_recovery {
    enabled = false
  }
}

resource "aws_dynamodb_table" "idempotency" {
  name         = "${local.name_prefix}-idempotency"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "ownerId"
  range_key    = "idempotencyKey"

  attribute {
    name = "ownerId"
    type = "S"
  }

  attribute {
    name = "idempotencyKey"
    type = "S"
  }

  point_in_time_recovery {
    enabled = false
  }
}
