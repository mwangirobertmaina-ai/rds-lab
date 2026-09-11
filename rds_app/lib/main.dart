import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import 'dart:convert';

void main() {
  runApp(const RDSApp());
}

class RDSApp extends StatelessWidget {
  const RDSApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'RDS Management Terminal',
      debugShowCheckedModeBanner: false,
      theme: ThemeData.dark().copyWith(
        scaffoldBackgroundColor: const Color(0xFF000000),
        primaryColor: const Color(0xFF00FF88),
      ),
      home: const RDSDashboard(),
    );
  }
}

class RDSDashboard extends StatefulWidget {
  const RDSDashboard({super.key});

  @override
  State<RDSDashboard> createState() => _RDSDashboardState();
}

class _RDSDashboardState extends State<RDSDashboard> {
  final String apiBase = "https://rds-lab.onrender.com";
  bool isLoading = true;
  bool isStkLoading = false;
  Map<String, dynamic> stats = {};

  final TextEditingController _phoneController = TextEditingController(text: "254");
  final TextEditingController _amountController = TextEditingController();
  String _stkStatusMessage = "";

  @override
  void initState() {
    super.initState();
    fetchSystemStats();
  }

  Future<void> fetchSystemStats() async {
    try {
      final response = await http.get(Uri.parse('$apiBase/system/stats'));
      if (response.statusCode == 200) {
        final data = json.decode(response.body);
        setState(() {
          stats = data['stats'] ?? {};
          isLoading = false;
        });
      }
    } catch (e) {
      setState(() {
        isLoading = false;
      });
    }
  }

  Future<void> triggerStkPush() async {
    final phone = _phoneController.text.trim();
    final amount = _amountController.text.trim();

    if (phone.isEmpty || amount.isEmpty) {
      setState(() {
        _stkStatusMessage = "⚠️ Please enter both phone number and amount.";
      });
      return;
    }

    setState(() {
      isStkLoading = true;
      _stkStatusMessage = "Initiating STK Push...";
    });

    try {
      final response = await http.post(
        Uri.parse('$apiBase/payments/stk-push'),
        headers: {'Content-Type': 'application/json'},
        body: json.encode({
          'phone': phone,
          'amount': amount,
        }),
      );

      final data = json.decode(response.body);
      if (response.statusCode == 200 || response.statusCode == 201) {
        setState(() {
          _stkStatusMessage = "✅ STK Push Sent! CheckoutRequestID: ${data['CheckoutRequestID'] ?? 'OK'}";
        });
      } else {
        setState(() {
          _stkStatusMessage = "❌ Failed: ${data['message'] ?? 'Server error'}";
        });
      }
    } catch (e) {
      setState(() {
        _stkStatusMessage = "❌ Network Error: Unable to reach backend.";
      });
    } finally {
      setState(() {
        isStkLoading = false;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: Row(
          children: const [
            Icon(Icons.settings, color: Color(0xFF00FF88)),
            SizedBox(width: 8),
            Text('RDS FLEET MANAGEMENT'),
          ],
        ),
        backgroundColor: const Color(0xFF111111),
        actions: [
          IconButton(
            icon: const Icon(Icons.refresh, color: Color(0xFF00FF88)),
            onPressed: () {
              setState(() => isLoading = true);
              fetchSystemStats();
            },
          )
        ],
      ),
      body: isLoading
          ? const Center(child: CircularProgressIndicator(color: Color(0xFF00FF88)))
          : SingleChildScrollView(
              padding: const EdgeInsets.all(16.0),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  GridView.count(
                    shrinkWrap: true,
                    physics: const NeverScrollableScrollPhysics(),
                    crossAxisCount: 2,
                    crossAxisSpacing: 10,
                    mainAxisSpacing: 10,
                    children: [
                      _buildStatCard("GROSS VOLUME", "\$${(stats['grossVolume'] ?? 0).toString()}"),
                      _buildStatCard("ACTIVE DRIVERS", "${stats['activeDrivers'] ?? 0}"),
                      _buildStatCard("ORDERS", "${stats['orders'] ?? 0}"),
                      _buildStatCard("MERCHANTS", "${stats['businesses'] ?? 0}"),
                    ],
                  ),
                  const SizedBox(height: 24),
                  _buildStkPushForm(),
                ],
              ),
            ),
    );
  }

  Widget _buildStatCard(String title, String value) {
    return Container(
      decoration: BoxDecoration(
        color: const Color(0xFF181818),
        border: Border.all(color: const Color(0xFF00FF88), width: 1),
        borderRadius: BorderRadius.circular(8),
      ),
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Text(title, style: const TextStyle(color: Colors.grey, fontSize: 12)),
          const SizedBox(height: 8),
          Text(value, style: const TextStyle(color: Color(0xFFFFD700), fontSize: 24, fontWeight: FontWeight.bold)),
        ],
      ),
    );
  }

  Widget _buildStkPushForm() {
    return Container(
      padding: const EdgeInsets.all(16.0),
      decoration: BoxDecoration(
        color: const Color(0xFF111111),
        border: Border.all(color: const Color(0xFF00FF88), width: 1),
        borderRadius: BorderRadius.circular(8),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: const [
              Icon(Icons.phone_android, color: Color(0xFF00FF88)),
              SizedBox(width: 8),
              Text(
                "M-PESA STK PUSH TERMINAL",
                style: TextStyle(color: Colors.white, fontSize: 16, fontWeight: FontWeight.bold),
              ),
            ],
          ),
          const SizedBox(height: 16),
          TextField(
            controller: _phoneController,
            keyboardType: TextInputType.phone,
            style: const TextStyle(color: Colors.white),
            decoration: const InputDecoration(
              labelText: "Phone Number (Format: 2547XXXXXXXX)",
              labelStyle: TextStyle(color: Colors.grey),
              enabledBorder: OutlineInputBorder(borderSide: BorderSide(color: Colors.grey)),
              focusedBorder: OutlineInputBorder(borderSide: BorderSide(color: Color(0xFF00FF88))),
            ),
          ),
          const SizedBox(height: 12),
          TextField(
            controller: _amountController,
            keyboardType: TextInputType.number,
            style: const TextStyle(color: Colors.white),
            decoration: const InputDecoration(
              labelText: "Amount (KES)",
              labelStyle: TextStyle(color: Colors.grey),
              enabledBorder: OutlineInputBorder(borderSide: BorderSide(color: Colors.grey)),
              focusedBorder: OutlineInputBorder(borderSide: BorderSide(color: Color(0xFF00FF88))),
            ),
          ),
          const SizedBox(height: 16),
          SizedBox(
            width: double.infinity,
            height: 48,
            child: ElevatedButton(
              style: ElevatedButton.styleFrom(
                backgroundColor: const Color(0xFF00FF88),
                foregroundColor: Colors.black,
              ),
              onPressed: isStkLoading ? null : triggerStkPush,
              child: isStkLoading
                  ? const CircularProgressIndicator(color: Colors.black)
                  : const Text("TRIGGER STK PUSH", style: TextStyle(fontWeight: FontWeight.bold)),
            ),
          ),
          if (_stkStatusMessage.isNotEmpty) ...[
            const SizedBox(height: 12),
            Text(
              _stkStatusMessage,
              style: TextStyle(
                color: _stkStatusMessage.startsWith("✅")
                    ? const Color(0xFF00FF88)
                    : _stkStatusMessage.startsWith("⚠️") || _stkStatusMessage.startsWith("Initiating")
                        ? Colors.amber
                        : Colors.redAccent,
                fontSize: 13,
              ),
            ),
          ]
        ],
      ),
    );
  }
}