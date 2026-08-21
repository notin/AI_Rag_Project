locals {
  name_prefix = "aws-api-lab-dev"

  # Encode the retention rule now so later log groups cannot default to never-expire.
  log_retention_days = 14
}
