output "aws_account_id" {
  description = "Must match 510724490747. If it does not, stop."
  value       = var.aws_account_id
}

output "aws_region" {
  value = var.aws_region
}

output "name_prefix" {
  value = local.name_prefix
}

output "log_retention_days" {
  value = local.log_retention_days
}

output "ops_topic_arn" {
  value = aws_sns_topic.ops.arn
}

output "budget_name" {
  value = aws_budgets_budget.monthly.name
}

output "alert_email" {
  value = var.alert_email
}
