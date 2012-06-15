"""
Copyright (c) 2011, 2012, Regents of the University of California
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions 
are met:

 - Redistributions of source code must retain the above copyright
   notice, this list of conditions and the following disclaimer.
 - Redistributions in binary form must reproduce the above copyright
   notice, this list of conditions and the following disclaimer in the
   documentation and/or other materials provided with the
   distribution.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
"AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS 
FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL 
THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, 
INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES 
(INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR 
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) 
HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, 
STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) 
ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED 
OF THE POSSIBILITY OF SUCH DAMAGE.
"""
"""
@author Stephen Dawson-Haggerty <stevedh@eecs.berkeley.edu>
"""
import uuid
import operator
import itertools
import numpy as np
import time

from twisted.internet import threads

from smap import core, util
from smap.driver import SmapDriver
from smap.archiver.queryparse import parse_opex
from smap.archiver.client import SmapClient, RepublishClient
from smap.operators import null, OperatorDriver
from smap.ops.grouping import GroupByTagOperator

class ExprDriver(OperatorDriver):
    """Driver which computes an operator on a set of input streams

Configuration options:
 Expression: operator expressions to compute
 Where: where-clause specifying the input streams
 Group: tag name indicating any grouping necessary
    """
    def setup(self, opts):
        self.expr = opts.get('Expression')
        self.restrict = opts.get('Restrict')
        self.group = opts.get('Group', None)
        self.tz = opts.get('Timezone', core.Timeseries.DEFAULTS['Properties/Timezone'])
        self.backend = opts.get('SourceUrl',
                                'http://ar1.openbms.org:8079')

        # get the operator
        self.op = parse_opex(self.expr)

    def start(self):
        d = threads.deferToThread(self.load_tags)
        d.addCallback(self.add_operators)
        d.addCallback(lambda _: OperatorDriver.start(self))

    def load_tags(self):
        """Load the matching tags (in a thread)"""
        c = SmapClient(self.backend)
        return c.tags(self.restrict)

    def add_operators(self, tags):
        """Bind the operator to the input streams and start processing"""
        self.operators = {}
        i = 0
        groups = {} 
        for s in tags:
            key = s.get(self.group, None)
            if not key in groups: groups[key] = []
            groups[key].append(s)

        self.loading = True
        for g, inputs in groups.iteritems():
            print "adding group", g, "(%i/%i)" % (i, len(groups))
            i += 1
            op = self.op(inputs) 
            for inp in op.inputs:
                self.operators[inp['uuid']] = op

            print "[" + ','.join(map(operator.itemgetter('uuid'), op.inputs)) + '] -> [' + \
                ','.join(map(operator.itemgetter('uuid'), op.outputs)) + ']'
            print op

            for stream in op.outputs:
                ts = core.Timeseries(uuid.UUID(stream['uuid']),
                                     stream.get('Properties/UnitofMeasure', 'None'),
                                     data_type=stream.get('Properties/ReadingType', 'double'),
                                     timezone=stream.get('Properties/Timezone', self.tz),
                                     description=stream.get('Description', None))
                #ts.set_metadata(util.build_recursive(stream).get('Metadata', {}))
                if self.group and not self.group in stream: continue
                if self.group:
                    assert len(op.outputs) == 1
                    path = '/' + util.str_path(stream[self.group])
                else:
                    path = '/' + str(stream['uuid'])
                self.add_timeseries(path, ts, recurse=False)
                self.set_metadata(path, {
                        'Extra/SourceStream' : \
                            ','.join(map(operator.itemgetter('uuid'), op.inputs)),
                        'Extra/Operator' : str(op.name)
                        })
                
        self.loading = False
            
    def _data(self, data):
        """Apply the operator to data"""
        #print "processing", data
        tic = time.time()
        dirty_operators = set([])
        for v in data.itervalues():
            if not 'uuid' in v or not 'Readings' in v: continue
            try:
                d = np.array(v['Readings'])
                d[:, 0] /= 1000
            except ValueError:
                continue
            self.operators[v['uuid']]._push(v['uuid'], d)
            dirty_operators.add(self.operators[v['uuid']])

        toc = time.time()
        boop = time.time()
        for op in dirty_operators:
            for dat, stream in itertools.izip(op._process(), op.outputs):
                streamid = uuid.UUID(stream['uuid'])
                for row in dat.tolist():
                    self.add(streamid, row[0], row[1])
        done = time.time()
        #print "prep", toc - tic, "proc", boop - toc, "add", done - boop
