"""Regenerate the synthetic password fixture with pypdf 6.10.0.

This is fixture authoring only; running the app or test suite needs no Python.
"""
from pathlib import Path
from pypdf import PdfWriter

writer = PdfWriter()
writer.add_blank_page(width=600, height=800)
writer.add_metadata({"/Title": "Synthetic TabMail password test"})
writer.encrypt("synthetic-test-password", algorithm="AES-256")
writer.write(Path(__file__).with_name("encrypted.pdf"))
