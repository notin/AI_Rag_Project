variable "aws_region" {
  type        = string
  description = "Sandbox region. Match the console; do not scatter resources."
  default     = "us-east-2"
}

variable "aws_account_id" {
  type        = string
  description = "Sandbox account. Terraform will refuse any other account."
  default     = "510724490747"
}

variable "aws_profile" {
  type        = string
  description = "Named CLI profile. Empty string uses the default credential chain."
  default     = "aws-api-lab"
}

variable "alert_email" {
  type        = string
  description = "Where budget (and later alarm) mail goes. Confirm the SNS subscription."
  default     = "chadvansyoc11@gmail.com"
}

variable "budget_limit_usd" {
  type        = number
  description = "Monthly cost cap that triggers SNS. Not a hard AWS spend stop."
  default     = 20
}
