terraform {
  required_version = ">= 1.6.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.80"
    }
  }

  # Local state is enough until Stage 7 (OIDC + remote backend).
  # Do not commit terraform.tfstate — it is gitignored.
  backend "local" {
    path = "terraform.tfstate"
  }
}
