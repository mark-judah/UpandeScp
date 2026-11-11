import hashlib

from frappe.model.document import Document


class CondensationAlert(Document):
	def autoname(self):
		# The name IS the unique key (greenhouse, day): a second insert for the
		# same house and day fails, which is what keeps it to ONE notice per
		# greenhouse per day even with two workers running the hourly check.
		self.name = "CA-" + hashlib.sha1(f"{self.greenhouse}|{self.alert_date}".encode()).hexdigest()[:12]
