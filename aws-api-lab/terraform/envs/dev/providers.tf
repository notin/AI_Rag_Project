provider "aws" {
  region  = var.aws_region
  profile = var.aws_profile != "" ? var.aws_profile : null

  # Refuse to run against any other account. This is the Stage 0
  # "do not create an incident" control.
  allowed_account_ids = [var.aws_account_id]

  default_tags {
    tags = {
      Project     = "aws-api-lab"
      Environment = "dev"
      ManagedBy   = "terraform"
    }
  }
}
