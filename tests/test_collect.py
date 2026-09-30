import unittest
from scripts.collect import parse_feed, blocked, clean_text

class CollectorTests(unittest.TestCase):
 def test_feed_parsing_and_source_domain(self):
  source={'name':'NASA','topic':'space','allowed_hosts':['www.nasa.gov']}
  feed=b'<rss><channel><item><title>A new moon</title><link>https://www.nasa.gov/moon/</link><description>&lt;p&gt;A lovely &amp;amp; interesting discovery&lt;/p&gt;</description></item><item><title>Bad link</title><link>https://evil.example/a</link></item></channel></rss>'
  posts=parse_feed(feed,source)
  self.assertEqual(len(posts),1)
  self.assertEqual(posts[0]['en']['summary'],'A lovely & interesting discovery')
  self.assertEqual(posts[0]['vi']['title'],'')
 def test_atom_feed_and_negative_filter(self):
  source={'name':'NASA','topic':'space','allowed_hosts':['www.nasa.gov']}
  feed=b'<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>Galaxy</title><link href="https://www.nasa.gov/galaxy/"/><summary>Stars!</summary></entry></feed>'
  self.assertEqual(parse_feed(feed,source)[0]['en']['title'],'Galaxy')
  self.assertTrue(blocked('A survivor of sexual assault shares her story'))
  self.assertTrue(blocked('Election results announced'))
  self.assertFalse(blocked('A star has been discovered'))
  self.assertEqual(clean_text('<script>bad()</script><p>Real fact</p>'),'Real fact')
