variable "product" {
}

variable "component" {
}

variable "location" {
  default = "UK South"
}

variable "env" {
}

variable "tenant_id" {}

variable "jenkins_AAD_objectId" {
  description = "(Required) The Azure AD object ID of a user, service principal or security group in the Azure Active Directory tenant for the vault. The object ID must be unique for the list of access policies."
}

variable "subscription" {}

variable "common_tags" {
  type = map(string)
}

variable "pgsql_version" {
  description = "The version of PostgreSQL Flexible Server to use."
  type        = string
  default     = "16"
}

variable "pgsql_create_mode" {
  description = "The creation mode which can be used to restore or replicate existing servers. Possible values are Default, PointInTimeRestore, Replica and Update."
  type        = string
  default     = "Default"
}

variable "aks_subscription_id" {
  description = "Subscription ID of the AKS/CFT vnet the Postgres Flexible Server injects into. Provided automatically by the Jenkins library in a real pipeline run; the default below is DTS-SPS-SBOX, confirmed against hmcts/shared-platform-services-infra's own sbox.tfvars (cross_tenant_peering.cnp_subscription_id) - the same subscription that hosts rg-sps-platform-sbox and rg-sps-platform-extid-sbox for this exact product."
  type        = string
  default     = "bd2864ed-4f3e-45ed-9c6a-8d179674bab1"
}
